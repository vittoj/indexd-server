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

  if (process.env.NETWORK == 'bitcoin') {
    network = bitcoin.networks.bitcoin
  } else if (process.env.NETWORK == 'litecoin') {
    network = bitcoin.networks.litecoin
  }

  let networkName = 'mainnet'

  if (opts.testnet) {
    network = bitcoin.networks.testnet
    networkName = 'testnet'
  } else if (opts.regtest) {
    network = bitcoin.networks.testnet
    networkName = 'regtest'
  }

  // convenience function to search ranges on leveldb
  let searchRange = (fn, scId, cb) => adapter[fn]({scId, heightRange: [0, 2500000], mempool: true}, 3000000, cb)

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

  function resolveHeight (heightQuery) {
      let height = parseInt(heightQuery)
      if (!Number.isFinite(height)) height = 0
      return height
  }

  router.get(apiPath + '/status', (req, res) => {
    parallel({
      localtip: (cb) => adapter.tips(cb),
      bitcoinheight: (cb) => rpc('getblockcount', [], cb)
    }, (err, results) => {
      if (err) return respond(req, res, err)

      let localheight = results.localtip ? results.localtip.txo.height : 0
      let bitcoinheight = results.bitcoinheight
      status = {
        chainBlock: bitcoinheight,
        indexBlock: localheight,
        network: networkName,
        blocksBehind: (bitcoinheight && localheight) ? (bitcoinheight - localheight) : null,
        ready: bitcoinheight && localheight && (bitcoinheight - localheight) <= 1,
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
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) { return respond(req, res, e) }

    let height = resolveHeight(req.query.height)
    let confirmedCount = parseInt(req.query.confirmed)

    // add confirmations to utxos
    parallel({
      tip: (cb) => adapter.tips(cb),
      utxos: (cb) => searchRange('utxosByScriptRange', scId, cb)
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
      if (!Number.isNaN(confirmedCount) && confirmedCount >= 0) {
        respond(req, res, null, utxos.filter(x => x.confirmations >= confirmedCount))
      } else {
        respond(req, res, null, utxos)
      }
    })
  })

  router.get(apiPath + '/a/:address/txos', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) { return respond(req, res, e) }

    let height = resolveHeight(req.query.height)
    let confirmedCount = parseInt(req.query.confirmed)

    // add confirmations to txos
    parallel({
      tip: (cb) => adapter.tips(cb),
      txos: (cb) => searchRange('txosByScriptRange', scId, cb)
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
      if (!Number.isNaN(confirmedCount) && confirmedCount >= 0) {
        respond(req, res, null, txos.filter(x => x.confirmations >= confirmedCount))
      } else {
        respond(req, res, null, txos)
      }
    })
  })

  router.get(apiPath + '/a/:address/txs', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) { return respond(req, res, e) }

    let height = resolveHeight(req.query.height)
    let verbose = req.query.verbose ? true : false
    let queryTxId = req.query.txid

    searchRange('transactionIdsByScriptRange', scId, (err, txIdSet) => {
      if (err) return respond(req, res, err)

      let tasks = {}
      for (let txId in txIdSet) {
        tasks[txId] = (next) => rpc('getrawtransaction', [txIdSet[txId], verbose], next)
      }

      parallel({
        tip: (cb) => adapter.tips(cb),
        ...tasks
      }, (err, {tip, ...result}) => {
        let txs = []
        let tipHeight = tip.txo.height

        Object.keys(result).map(id => txs.push(result[id]))

        if (!err) {
          if (verbose) {
            txs = txs.map(tx => ({ height: tipHeight - tx.confirmations, ...tx }))
          }
        }

        if (req.query.page && req.query.per_page) {
          let qpage = parseInt(req.query.page)
          let qperPage = parseInt(req.query.per_page)

          if (!(Number.isNaN(qpage) || Number.isNaN(qperPage)) && (qpage > 0) && (qperPage > 0)) {
            let start = qperPage * (qpage - 1)
            let end = start + qperPage

            txs = {
              txs: txs.slice(start, end), tx_count: txs.length // Pretty innefficient, should slice from the data query
            }
          }
        }

        respond(req, res, err, txs)
      })
    })
  })

  router.get(apiPath + '/a/:address/balance', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) { return respond(req, res, e) }

    let height = resolveHeight(req.query.height)

    searchRange('utxosByScriptRange', scId, (err, results) => {
      if (err) return respond(req, res, err)

      respond(req, res, null, results.reduce((p, x) => p + x.value, 0))
    })
  })

  router.get(apiPath + '/a/:address/unconfirmedBalance', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) { return respond(req, res, e) }

    let height = resolveHeight(req.query.height)

    parallel({
      tip: (cb) => adapter.tips(cb),
      utxos: (cb) => searchRange('utxosByScriptRange', scId, cb)
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

      respond(req, res, null, utxos.filter(x => x.confirmations === 0).reduce((p, x) => p + x.value, 0))
    })
  })

  router.get(apiPath + '/a/:address/confirmedBalance', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) { return respond(req, res, e) }

    let height = resolveHeight(req.query.height)

    parallel({
      tip: (cb) => adapter.tips(cb),
      utxos: (cb) => searchRange('utxosByScriptRange', scId, cb)
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

      respond(req, res, null, utxos.filter(x => x.confirmations >0).reduce((p, x) => p + x.value, 0))
    })
  })

  return router
}
