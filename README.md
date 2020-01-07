# Barkeeper

Barkeeper is a express middleware for handling `multipart/form-data` and persist in redis, which is used for uploading files to redis.

## Basic Usage

Install:

```sh
$ npm i @nxcd/barkeeper
```

Import and use:

```js
const redis = require('redis')
const express = require('express')

// Import barkeeper
const { Barkeeper } = require('@nxcd/barkeeper')

const redisClient = redis.createClient({ return_buffers: true }) // To save

const config = {
  ttl: 360 // Time to redis key expire in seconds
}

const barkeeper = barkeeperFactory(redisClient, config)

const app = express()

app.post('/file', barkeeper.upload({}), (req, res, next) => {
  // req.files is an array of files
})
```

## API

### Files information
Files contains an array of objects, each file contains the following information:

Key | Description
--- | --- | ---
`key` | Key to identify in redis
`fieldname` | Field name specified in the form
`name` | Name of the file on the user's computer
`encoding` | Encoding type of the file
`mimetype` | Mime type of the file

