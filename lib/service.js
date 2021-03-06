let indexd = require('indexd')
let leveldown = require('leveldown')
let qup = require('qup')
let rpc = require('./rpc')
let zmq = require('zeromq')

let debug = require('debug')('service')
let debugZmq = require('debug')('zmq')
let debugZmqTx = require('debug')('zmq:tx')
let debugZmqBlock = require('debug')('zmq:block')


module.exports = function initialize (callback) {
  function errorSink (err) {
    if (err) debug(err)
  }

  debug(`Init leveldb @ ${process.env.INDEXDB}`)
  let db = leveldown(process.env.INDEXDB)
  let adapter = new indexd(db, rpc)

  if (!process.env.INCLUDE_SUPERFLUOUS_INDEXES) {
    // Remove unwanted indexes (we don't use these in production)
    delete adapter.indexes.fee
    delete adapter.indexes.mtp
  }

  if (!process.env.INCLUDE_EXTRA_INDEXES) {
    delete adapter.indexes.tx
    delete adapter.indexes.txo
  }

  // default configurations
  let dbWriteBufferSize = 256 * 1024 * 1024
  let dbCacheSize = 1 * 1024 * 1024 * 1024
  let dbMaxOpenFiles = 63 * 1024
  let dbMaxFileSize = 8 * 1024 * 1024
  if (process.env.DB_WRITE_BUFFER_SIZE) {
    dbWriteBufferSize = parseInt(process.env.DB_WRITE_BUFFER_SIZE)
  }
  if (process.env.DB_CACHE_SIZE) {
    dbCacheSize = parseInt(process.env.DB_CACHE_SIZE)
  }
  if (process.env.DB_MAX_OPEN_FILES) {
    dbMaxOpenFiles = parseInt(process.env.DB_MAX_OPEN_FILES)
  }
  if (process.env.DB_MAX_FILE_SIZE) {
    dbMaxFileSize = parseInt(process.env.DB_MAX_FILE_SIZE)
  }

  db.open({
    writeBufferSize: dbWriteBufferSize,
    cacheSize: dbCacheSize,
    maxOpenFiles: dbMaxOpenFiles,
    maxFileSize: dbMaxFileSize
  }, (err) => {
    if (err) return callback(err, adapter)
    debug(`Opened leveldb @ ${process.env.INDEXDB}`)

    if (process.env.DB_COMPACT_ON_START) {
      debug('Start compacting leveldb')
      db.compactRange(-Infinity, Infinity, function () {
        debug('Finished compacting leveldb')
      })
    }

    if (process.env.ZMQ) {
      let zmqSock = zmq.socket('sub')

      let connect = () => {
        zmqSock.connect(process.env.ZMQ)
        zmqSock.subscribe('hashblock')
        zmqSock.subscribe('hashtx')
      }

      zmqSock.on('connect', () => {
        debugZmq('connected')
      })

      zmqSock.on('close', () => {
        debugZmq('Connection closed, reconnecting')
        connect()
      })
      zmqSock.on('disconnected', () => {
        debugZmq('Disconnected, reconnecting')
        connect()
      })
      zmqSock.on('monitor_error', () => {
        zmqSock.monitor(500, 0)
      })
      zmqSock.monitor(500, 0)

      let lastSequence = {}
      zmqSock.on('message', (topic, message, sequence) => {
        topic = topic.toString('utf8')
        message = message.toString('hex')
        sequence = sequence.readUInt32LE()

        // if any ZMQ messages were lost,  assume a resync is required
        if (lastSequence[topic] !== undefined && (sequence !== (lastSequence[topic] + 1))) {
          debugZmq(`${sequence - lastSequence[topic] - 1} ${topic} messages lost`)
          lastSequence[topic] = sequence
          if (topic === 'hashblock') {
            return adapter.tryResync(errorSink)
          } else if (topic === 'hashtx') {
            return adapter.tryResyncMempool(errorSink)
          }
        }
        lastSequence[topic] = sequence

        // resync every block
        if (topic === 'hashblock') {
          debugZmqBlock(topic, message)
          return adapter.tryResync(errorSink)
        } else if (topic === 'hashtx') {
          debugZmqTx(topic, message)
          return adapter.notify(message, errorSink)
        }
      })

      connect()
    }

    adapter.tryResync(errorSink)
    adapter.tryResyncMempool(errorSink)
    callback(null, adapter)

    // This interval is set as a fallback just in case ZMQ is misbehaving
    if (process.env.FORCE_SYNC_INTERVAL) {
      let interval = parseInt(process.env.FORCE_SYNC_INTERVAL)
      if (Number.isNaN(interval) || !Number.isInteger(interval) || interval < 1000) {
        throw new Error('FORCE_SYNC_INTERVAL must be an integer greater equal than 1000')
      } 
      setInterval(() => {
        adapter.tryResync(errorSink)
        adapter.tryResyncMempool(errorSink)
      }, interval)
    }
  })
}
