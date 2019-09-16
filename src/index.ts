import uuid from 'uuid/v4'
import Busboy from 'busboy'
import boom from '@hapi/boom'
import { Redis as RedisClient } from 'ioredis'
import { format } from 'util'
import { Request, Response, NextFunction } from 'express'
import onFinished from 'on-finished'

import { IRequestFiles } from './structures/interfaces/IRequestFiles'
import { IEnabledFields } from './structures/interfaces/IEnabledFields'
import { IBarkeeperConfig } from './structures/interfaces/IBarkeeperConfig'
import { IUploadBarkeeperConfig } from './structures/interfaces/IUploadBarkeeperConfig'

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

    const isValidMimetype = expectedMimetypes.find((expectedMimetype) => expectedMimetype === mimetype)

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

    return (req: Request, _res: Response, next: NextFunction) => {
      busboyConfig.headers = req.headers

      const boy = new Busboy(busboyConfig)

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
        onFinished(req, () => next(error))
        isDone = true
      }

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
        Object.defineProperty(req, 'files', {
          value: (files as any[]),
          writable: false
        })

        done()
      })

      req.pipe(boy)
    }
  }
}
