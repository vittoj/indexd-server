let debug = require('debug')('express')
let bitcoin = require('bitcoinjs-lib')
let bodyParser = require('body-parser')
let express = require('express')
let parallel = require('run-parallel')
let rpc = require('./rpc')
let bech32 = require('bech32')
let inspect = require('util').inspect
var bchaddr = require('bchaddrjs')

function Hex256bit (value) {
  return typeof value === 'string' &&
    /^([0-9a-f]{2})+$/i.test(value) &&
    value.length === 64
}

module.exports = function initialize (adapter, opts) {
  let router = new express.Router()
  let apiPath = process.env.API_PATH
  let network

  network = bitcoin.networks[process.env.NETWORK]

  let networkName = 'mainnet'

  if (opts.testnet) {
    network = bitcoin.networks.testnet
    networkName = 'testnet'
  } else if (opts.regtest) {
    network = bitcoin.networks.testnet
    networkName = 'regtest'
  }

  let maxResults = 1000000
  if (process.env.MAX_ROWS_LEVELDB) {
    try {
      let newMaxResults = parseInt(process.env.MAX_ROWS_LEVELDB)

      if (Number.isNaN(newMaxResults) || !Number.isInteger(newMaxResults) || newMaxResults <= 0) {
        throw new Error('MAX_ROWS_LEVELDB must be a positive non-zero integer')
      } else {
        maxResults = newMaxResults
      }
    } catch(e) {
      debug('Invalid value for MAX_ROWS_LEVELDB', e)
    }
  }

  // convenience function to search ranges on leveldb
  let searchRange = (fn, scId, from, to, mem, cb) => {
    adapter[fn]({scId, heightRange: [from, to], mempool: mem}, maxResults, cb)
  }

  function respond (req, res, err, result) {
    if (err) debug('ERR: '+req.path, err)
    if (err) {
      let errMsg
      if (typeof err === 'number') {
        res.status(err)
      } else {
        if (typeof err === 'object' && err.message) {
          res.status((err.status && typeof err.status === 'number') ? err.status : 400)
          errMsg = ''+err.message
        } else {
          res.status(400)
          errMsg = ''+err
        }
      }
      res.json({error: errMsg})
      return res.end()
    }

    res.status(200)
    if (result !== undefined) {
      if (typeof result === 'string') res.send(result)
      else if (Buffer.isBuffer(result)) res.send(result)
      else res.json(result)
    }
    res.end()
  }

  function checkIntegerParam (param) {
    let integer = parseInt(param)
    if (Number.isNaN(integer) || !Number.isInteger(integer)) {
      throw new Error('Param must be an integer')
    }
    return integer
  }

  function resolveHeight (heightQuery) {
    let height = parseInt(heightQuery)
    if (Number.isNaN(height) || !Number.isInteger(height) || height < 0) {
      throw new Error('Height must be an integer greater equal than zero')
    }
    return height
  }

  router.get(apiPath + '/status', (req, res) => {
    parallel({
      localtip: (cb) => adapter.tips(cb),
      bitcoinheight: (cb) => rpc('getblockcount', [], cb)
    }, (err, results) => {
      if (err) return respond(req, res, err)

      let localheight = results.localtip.txo ? results.localtip.txo.height : null
      let bitcoinheight = results.bitcoinheight
      status = {
        chainBlock: bitcoinheight,
        indexBlock: localheight,
        network: networkName,
        blocksBehind: (bitcoinheight && localheight) ? (bitcoinheight - localheight) : null,
        ready: bitcoinheight && localheight ? ((bitcoinheight - localheight) <= 1) : false
      }

      respond(req, res, null, status)
    })
  })

  function addressToScriptId(address) {
    let script = null

    if (address.startsWith('bitcoincash:q') || address.startsWith('q')) {
      address = bchaddr.toLegacyAddress(address)
    }

    if (address.startsWith('bc') || address.startsWith('tb')) {
      // Regtest starts with 'bc' too
      let b32res = bech32.decode(address)
      let witnessData = bech32.fromWords(b32res.words.slice(1))
      let witnessOpcodes = [0, 0x14]
      script = Buffer.from(witnessOpcodes.concat(witnessData))
    } else {
      script = bitcoin.address.toOutputScript(address, network)
      console.log('Output Script ID', script.toString('hex'))
    }

    return bitcoin.crypto.sha256(script).toString('hex')
  }

  router.get(apiPath + '/a/:address/utxos', (req, res) => {
    let scId
    let fromHeight = 0
    let toHeight = 0xffffffff
    let mem = true
    let confirmedCount = 0
    let perPage = 0
    let pageNum = 0

    try {
      scId = addressToScriptId(req.params.address)

      if (req.query.from) fromHeight = resolveHeight(req.query.from)
      if (req.query.to) toHeight = resolveHeight(req.query.to)
      if (req.query.nomem) mem = false

      if (req.query.confirmed) confirmedCount = checkIntegerParam(req.query.confirmed)

      if (req.query.per_page) perPage = checkIntegerParam(req.query.per_page)
      if (req.query.page) pageNum = checkIntegerParam(req.query.page)
    } catch (e) { return respond(req, res, e) }

    // add confirmations to utxos
    parallel({
      tip: (cb) => adapter.tips(cb),
      utxos: (cb) => searchRange('utxosByScriptRange', scId, fromHeight, toHeight, mem, cb)
    }, (err, results) => {
      if (err) return respond(req, res, err)

      let tipHeight = results.tip.txo.height
      let utxos = []

      Object.keys(results.utxos).forEach(function (key) {
        let utxo = results.utxos[key]
        let height = utxo.height
        if (height && height >= 0 && height <= tipHeight) {
          utxo.confirmations = tipHeight - height + 1
        } else {
          utxo.confirmations = 0
        }

        // we don't care about the scId
        delete utxo.scId

        utxos.push(utxo)
      })

      if (confirmedCount > 0) {
        utxos = utxos.filter(x => x.confirmations >= confirmedCount)
      }

      if (perPage > 0 && pageNum > 0) {
        let start = perPage * (pageNum - 1)
        let end = start + perPage
        utxos = {
          utxos: utxos.slice(start, end), tx_count: utxos.length // Pretty innefficient, should slice from the data query
        }
      }

      respond(req, res, null, utxos)
    })
  })

  router.get(apiPath + '/a/:address/txos', (req, res) => {
    let scId
    let fromHeight = 0
    let toHeight = 0xffffffff
    let mem = true
    let confirmedCount = 0
    let perPage = 0
    let pageNum = 0

    try {
      scId = addressToScriptId(req.params.address)

      if (req.query.from) fromHeight = resolveHeight(req.query.from)
      if (req.query.to) toHeight = resolveHeight(req.query.to)
      if (req.query.nomem) mem = false

      if (req.query.confirmed) confirmedCount = checkIntegerParam(req.query.confirmed)

      if (req.query.per_page) perPage = checkIntegerParam(req.query.per_page)
      if (req.query.page) pageNum = checkIntegerParam(req.query.page)
    } catch (e) { return respond(req, res, e) }

    // add confirmations to txos
    parallel({
      tip: (cb) => adapter.tips(cb),
      txos: (cb) => searchRange('txosByScriptRange', scId, fromHeight, toHeight, mem, cb)
    }, (err, results) => {
      if (err) return respond(req, res, err)

      let tipHeight = results.tip.txo.height
      let txos = []

      Object.keys(results.txos).forEach(function (key) {
        let txo = results.txos[key]
        let height = txo.height
        if (height && height >= 0 && height <= tipHeight) {
          txo.confirmations = tipHeight - height + 1
        } else {
          txo.confirmations = 0
        }

        // we don't care about the scId
        delete txo.scId

        txos.push(txo)
      })

      if (confirmedCount > 0) {
        txos = txos.filter(x => x.confirmations >= confirmedCount)
      }

      if (perPage > 0 && pageNum > 0) {
        let start = perPage * (pageNum - 1)
        let end = start + perPage
        txos = {
          txos: txos.slice(start, end), tx_count: txos.length // Pretty innefficient, should slice from the data query
        }
      }

      respond(req, res, null, txos)
    })
  })

  router.get(apiPath + '/a/:address/txs', (req, res) => {
    let scId
    let fromHeight = 0
    let toHeight = 0xffffffff
    let mem = true
    let verbose = 0
    let perPage = 0
    let pageNum = 0

    try {
      scId = addressToScriptId(req.params.address)

      if (req.query.from) fromHeight = resolveHeight(req.query.from)
      if (req.query.to) toHeight = resolveHeight(req.query.to)
      if (req.query.nomem) mem = false

      if (req.query.verbose) verbose = checkIntegerParam(req.query.verbose)

      if (req.query.per_page) perPage = checkIntegerParam(req.query.per_page)
      if (req.query.page) pageNum = checkIntegerParam(req.query.page)
    } catch (e) { return respond(req, res, e) }

    searchRange('transactionIdsByScriptRange', scId, fromHeight, toHeight, mem, (err, txIdSet) => {
      if (err) return respond(req, res, err)

      let tasks = {}
      for (let txId in txIdSet) {
        tasks[txId] = (next) => rpc('getrawtransaction', [txIdSet[txId], verbose >= 1], next)
      }

      parallel({
        tip: (cb) => adapter.tips(cb),
        ...tasks
      }, (err, {tip, ...result}) => {
        if (err) return respond(req, res, err)

        let txs = []
        let tipHeight = tip.txo.height

        Object.keys(result).map(id => txs.push(result[id]))

        if (verbose >= 1) {
          txs = txs.map(tx => ({ height: tipHeight - tx.confirmations, ...tx }))
        }

        if (perPage > 0 && pageNum > 0) {
          let start = perPage * (pageNum - 1)
          let end = start + perPage
          txs = {
            txs: txs.slice(start, end), tx_count: txs.length // Pretty innefficient, should slice from the data query
          }
        }

        respond(req, res, err, txs)
      })
    })
  })

  router.get(apiPath + '/a/:address/balance', (req, res) => {
    let scId
    let fromHeight = 0
    let toHeight = 0xffffffff
    let mem = true
    let verbose = 0

    try {
      scId = addressToScriptId(req.params.address)

      if (req.query.from) fromHeight = resolveHeight(req.query.from)
      if (req.query.to) toHeight = resolveHeight(req.query.to)
      if (req.query.nomem) mem = false

      if (req.query.verbose) verbose = checkIntegerParam(req.query.verbose)
    } catch (e) { return respond(req, res, e) }

    if (verbose >= 1) {
      parallel({
        tip: (cb) => adapter.tips(cb),
        utxos: (cb) => searchRange('utxosByScriptRange', scId, fromHeight, toHeight, mem, cb)
      }, (err, results) => {
        if (err) return respond(req, res, err)
  
        let tipHeight = results.tip.txo.height
        let confirmedBalance = 0
        let unconfirmedBalance = 0
  
        Object.keys(results.utxos).forEach(function (key) {
          let utxo = results.utxos[key]
          let height = utxo.height
          if (height && height >= 0 && height < tipHeight) {
            confirmedBalance += utxo.value
          } else {
            unconfirmedBalance += utxo.value
          }
        })
        let result = {}
        result['balance'] = confirmedBalance + unconfirmedBalance
        result['confirmed'] = confirmedBalance
        result['unconfirmed'] = unconfirmedBalance
        respond(req, res, null, result)
      })
    } else {
      searchRange('utxosByScriptRange', scId, fromHeight, toHeight, mem, (err, results) => {
        if (err) return respond(req, res, err)

        respond(req, res, null, results.reduce((p, x) => p + x.value, 0))
      })
    }
  })

  return router
}
