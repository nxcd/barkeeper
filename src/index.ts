import uuid from 'uuid/v4'
import Busboy from 'busboy'
import boom from '@hapi/boom'
import { Redis as RedisClient } from 'ioredis'
import { format } from 'util'
import { Request, Response, NextFunction } from 'express'
import onFinished from 'on-finished'
import FileType from 'file-type'
import axios from 'axios'

import { IRequestFiles } from './structures/interfaces/IRequestFiles'
import { IEnabledFields } from './structures/interfaces/IEnabledFields'
import { IBarkeeperConfig } from './structures/interfaces/IBarkeeperConfig'
import { IUploadBarkeeperConfig } from './structures/interfaces/IUploadBarkeeperConfig'

async function getBufferFromInput (inputType: 'base64' | 'urls', fileContent: string): Promise<Buffer> {
  if (inputType === 'base64') {
    return Buffer.from(fileContent, 'base64')
  }

  const { data } = await axios.get(fileContent, {
    responseType: 'arraybuffer'
  })

  return Buffer.from(data, 'base64')
}

function getFilesFromBody (inputType: 'base64' | 'urls', bodyUrlFieldName: string, bodyBase64FieldName: string, requestBody: any): Array<{ fieldName: string, fileContent: string }> {
  const input = inputType === 'base64'
    ? requestBody[bodyBase64FieldName]
    : requestBody[bodyUrlFieldName]

  if (typeof input === 'string') {
    return [{
      fieldName: inputType,
      fileContent: input
    }]
  }

  return Object.keys(input).map((inputKey) => {
    return {
      fieldName: inputKey,
      fileContent: input[inputKey]
    }
  })
}

function jsonMiddleware (redisClient: RedisClient, ttl: number, config: IUploadBarkeeperConfig) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const { bodyBase64FieldName = 'base64', bodyUrlFieldName = 'urls' } = config || {}

    if (!req.body || (!req.body[bodyBase64FieldName] && !req.body[bodyUrlFieldName])) {
      return next(boom.notAcceptable(`Invalid payload. To json request use \"${bodyBase64FieldName}\" or \"${bodyUrlFieldName}\" fields`))
    }

    const inputType = req.body[bodyBase64FieldName]
      ? 'base64'
      : 'urls'

    const files = getFilesFromBody(inputType, bodyUrlFieldName, bodyBase64FieldName, req.body)

    const filesPromises = files.map(async ({ fieldName, fileContent }) => {
      const fileKey = uuid()

      const buffer = await getBufferFromInput(inputType, fileContent)

      const fileTypeResult = await FileType.fromBuffer(buffer)

      await redisClient.set(fileKey, buffer.toString('base64'), 'EX', ttl)

      return {
        key: fileKey,
        fieldname: fieldName,
        name: fieldName,
        encoding: 'base64',
        mimetype: fileTypeResult ? fileTypeResult.mime : '',
        size: buffer.byteLength
      }
    })

    Promise.all(filesPromises)
      .then((files) => {
        Object.defineProperty(req, 'files', {
          value: files,
          writable: false
        })

        next()
      })
      .catch((err: any) => {
        next(err)
      })
  }
}

function drainStream (stream: any) {
  stream.on('readable', stream.read.bind(stream))
}

function fields (enabledFields: IEnabledFields[] = [], enabledAdditionalFields: boolean, generalLimits: { files: number }, generalMimetypes: string[]) {
  function getLimitsByField (field: string) {
    if (!enabledFields.length) {
      return
    }

    const expectedField = enabledFields.find((enabledField: IEnabledFields) => enabledField.field === field)

    if (!expectedField) {
      return
    }

    if (!expectedField.limits || !expectedField.limits.files) {
      return {
        files: 1 // default
      }
    }

    return expectedField.limits
  }

  function getExpectedMimetypesByField (field: string): string[] | undefined {
    if (!enabledFields.length) {
      return
    }

    const expectedField = enabledFields.find((enabledField: IEnabledFields) => enabledField.field === field)

    if (!expectedField) {
      return
    }

    return expectedField.mimetypes
  }

  function validField (field: string) {
    if (!enabledFields.length) {
      return
    }

    const limits = getLimitsByField(field)

    if (limits) {
      return { limits }
    }

    if (enabledAdditionalFields) {
      return
    }

    const message = format('The field %s is not expected', field)
    throw boom.badData(message)
  }

  function validMimeTypes (field: string, mimetype: string) {
    if (!enabledFields.length && !generalMimetypes.length) {
      return
    }

    const expectedMimetypes = enabledFields.length ? getExpectedMimetypesByField(field) : generalMimetypes

    if (!expectedMimetypes) {
      return
    }

    const isValidMimetype = expectedMimetypes.find((expectedMimetype) => mimetype.includes(expectedMimetype))

    if (isValidMimetype) {
      return
    }

    const message = enabledFields.length
      ? `The field ${field} expected on of the following mimetypes: ${expectedMimetypes}`
      : `Expected on of the following mimetypes: ${expectedMimetypes}`

    throw boom.badData(message)
  }

  function validMaxFiles (files: IRequestFiles[], field: string) {
    const isValidField = validField(field)

    if (!isValidField && (!generalLimits || !generalLimits.files)) {
      return
    }

    const { files: filesLimit } = isValidField ? isValidField.limits : generalLimits

    const countFiles = isValidField ? files.filter(({ fieldname }) => fieldname === field).length : files.length

    if (countFiles < filesLimit) {
      return
    }

    const message = isValidField
      ? format('The field %s accepts a maximum of %s files', field, filesLimit)
      : format('Accepts a maximum of %s files', filesLimit)

    throw boom.badData(message)
  }

  return {
    validField,
    validMaxFiles,
    validMimeTypes
  }
}

export class Barkeeper {
  private _ttl: number
  private _redisClient: RedisClient

  constructor (redisClient: RedisClient, options: IBarkeeperConfig = {}) {
    this._redisClient = redisClient
    this._ttl = options.ttl || 60 * 60
  }

  upload (config: IUploadBarkeeperConfig) {
    const { busboy: busboyConfig = {}, enabledAdditionalFields = false, enabledFields, limits, mimetypes = [] } = config

    const validator = fields(enabledFields, enabledAdditionalFields, limits, mimetypes)

    return async (req: Request, res: Response, next: NextFunction) => {
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json') && config.mimetypes.includes('application/json')) {
        jsonMiddleware(this._redisClient, this._ttl, config)(req, res, next)

        return
      }

      busboyConfig.headers = req.headers

      let boy: any

      try {
        boy = new Busboy(busboyConfig)
      } catch (err) {
        drainStream(req)
        onFinished(req, () => next(boom.unsupportedMediaType(err.message)))
        return
      }

      const files: IRequestFiles[] = []

      let pendingWrites = 0
      let isDone = false

      const done = (error?: any): void => {
        if (isDone) {
          return
        }

        if ((!error && pendingWrites)) {
          return
        }

        req.unpipe(boy)
        drainStream(req)
        boy.removeAllListeners()

        Object.defineProperty(req, 'files', {
          value: (files as any[]),
          writable: false
        })

        onFinished(req, () => next(error))
        isDone = true
      }

      boy.on('field', async (fieldname: string, fieldValue: string): Promise<void> => {
        if (!fieldname || !fieldValue) {
          return
        }

        try {
          validator.validField(fieldname)
        } catch (err) {
          return done(err)
        }

        pendingWrites++

        const buffer = Buffer.from(fieldValue, 'base64')
        const { mime: mimetype = '' } = await FileType.fromBuffer(buffer) || {}

        try {
          validator.validMimeTypes(fieldname, mimetype)
        } catch (err) {
          return done(err)
        }

        const fileKey = uuid()

        this._redisClient.set(fileKey, fieldValue, 'EX', this._ttl, (err) => {
          if (err) {
            return done(err)
          }

          pendingWrites--

          try {
            validator.validMaxFiles(files, fieldname)
          } catch (err) {
            return done(err)
          }

          files.push({
            key: fileKey,
            fieldname,
            name: 'filename',
            encoding: 'base64',
            mimetype,
            size: buffer.byteLength
          })

          done()
        })
      })

      boy.on('file', async (fieldname: string, fileStream: NodeJS.ReadableStream, filename: string, encoding: string, mimetype: string): Promise<void> => {
        if (!filename) {
          fileStream.resume()

          return
        }

        try {
          validator.validField(fieldname)
        } catch (err) {
          fileStream.resume()
          return done(err)
        }

        try {
          validator.validMimeTypes(fieldname, mimetype)
        } catch (err) {
          fileStream.resume()
          return done(err)
        }

        const buffersFile: Buffer[] = []

        pendingWrites++

        const fileKey = uuid()

        fileStream.on('data', chunk => {
          buffersFile.push(chunk)
        })

        fileStream.on('error', (err: any) => {
          done(err)
        })

        fileStream.on('limit', function () {
          done(boom.entityTooLarge('file too large', { code: 'LIMIT_FILE_SIZE' }))
        })

        fileStream.on('end', () => {
          const buffer = Buffer.concat(buffersFile)

          this._redisClient.set(fileKey, buffer.toString('base64'), 'EX', this._ttl, (err) => {
            if (err) {
              return done(err)
            }

            pendingWrites--

            try {
              validator.validMaxFiles(files, fieldname)
            } catch (err) {
              fileStream.resume()
              return done(err)
            }

            files.push({
              key: fileKey,
              fieldname,
              name: filename,
              encoding,
              mimetype,
              size: buffer.byteLength
            })

            if (pendingWrites) {
              return
            }

            done()
          })
        })
      })

      boy.on('error', (err: any) => { done(err) })
      boy.on('filesLimit', () => { done(boom.entityTooLarge('To many files', { code: 'LIMIT_FILE_COUNT' })) })
      boy.on('partsLimit', () => { done(boom.entityTooLarge('Too many parts', { code: 'LIMIT_PART_COUNT' })) })
      boy.on('fieldsLimit', () => { done(boom.entityTooLarge('To many fields', { code: 'LIMIT_FIELD_COUNT' })) })

      boy.on('finish', () => {
        done()
      })

      req.pipe(boy)
    }
  }
}
