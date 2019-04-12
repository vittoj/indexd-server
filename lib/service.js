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

  db.open({
    writeBufferSize: 256 * 1024 * 1024,
    cacheSize: 1 * 1024 * 1024 * 1024,
    maxOpenFiles: 64512,
    maxFileSize: 8 * 1024 * 1024
  }, (err) => {
    if (err) return callback(err, adapter)
    debug(`Opened leveldb @ ${process.env.INDEXDB}`)

    if (process.env.COMPACT_DB) {
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
          debugZmq(`${sequence - lastSequence[topic] - 1} messages lost`)
          lastSequence[topic] = sequence
          adapter.tryResync(errorSink)
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
    callback(null, adapter)

    // This interval is set as a fallback just in case ZMQ is misbehaving
    if (process.env.FORCE_SYNC_INTERVAL) {
      let interval = parseInt(process.env.FORCE_SYNC_INTERVAL)
      if (Number.isNaN(interval) || !Number.isInteger(interval) || interval < 1000) {
        throw new Error('FORCE_SYNC_INTERVAL must be an integer greater equal than 1000')
      } 
      setInterval(() => {
        adapter.tryResync(errorSink)
      }, interval)
    }
  })
}
