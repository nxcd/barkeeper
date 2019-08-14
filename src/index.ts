import uuid from 'uuid/v4'
import Busboy from 'busboy'
import { RedisClient } from 'redis'

import { Request, Response, RequestHandler, NextFunction } from 'express'

import { IBarkeeperConfig } from './structures/interfaces/IBarkeeperConfig'

export function factory (redisClient: RedisClient, options: IBarkeeperConfig = {}): RequestHandler[] {
  const { ttl = 60 * 60 } = options

  return [(req: Request, _res: Response, next: NextFunction) => {
    const boy = new Busboy({ headers: req.headers })

    const files: any[] | { key: string; fieldname: string; name: string; encoding: string; mimetype: string; }[] = []

    boy.on('file', async (fieldname: string, file: NodeJS.ReadableStream, filename: string, encoding: string, mimetype: string) => {
      file.resume()

      const fileKey = uuid()

      files.push({
        key: fileKey,
        fieldname,
        name: filename,
        encoding,
        mimetype
      })

      redisClient.set(fileKey, '', 'EX', ttl)

      file.on('data', chunk => {
        redisClient.append(fileKey, chunk)
      })
    })

    boy.on('finish', () => {
      Object.defineProperty(req, 'files', {
        value: (files as any[]),
        writable: false
      })

      next()
    })

    req.pipe(boy)
  }]
}
