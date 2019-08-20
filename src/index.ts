import uuid from 'uuid/v4'
import Busboy from 'busboy'
import { RedisClient } from 'redis'
import { Request, Response, RequestHandler, NextFunction } from 'express'

import { IBarkeeperConfig } from './structures/interfaces/IBarkeeperConfig'

export function factory (redisClient: RedisClient, options: IBarkeeperConfig = {}): RequestHandler[] {
  const { ttl = 60 * 60 } = options

  return [(req: Request, _res: Response, next: NextFunction) => {
    const boy = new Busboy({ headers: req.headers })

    const files: any[] | {key: string, fieldname: string, name: string, encoding: string, mimetype: string, size: number }[] = []

    let pendingWrites = 0

    boy.on('file', async (fieldname: string, fileStream: NodeJS.ReadableStream, filename: string, encoding: string, mimetype: string): Promise<void> => {
      if (!filename) {
        fileStream.resume()

        return
      }

      const buffersFile: Buffer[] = []

      pendingWrites++

      const fileKey = uuid()

      fileStream.on('data', chunk => {
        buffersFile.push(chunk)
      })

      fileStream.on('end', () => {
        const buffer = Buffer.concat(buffersFile)

        redisClient.set(fileKey, buffer.toString(), 'EX', ttl, (err) => {
          if (err) {
            next(err)

            return
          }

          pendingWrites--

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

          next()
        })
      })
    })

    boy.on('finish', () => {
      Object.defineProperty(req, 'files', {
        value: (files as any[]),
        writable: false
      })
    })

    req.pipe(boy)
  }]
}
