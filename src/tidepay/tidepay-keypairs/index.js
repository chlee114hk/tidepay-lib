'use strict';
var assert = require('assert');
var brorand = require('brorand');
var hashjs = require('hash.js');
var elliptic = require('elliptic');
var Ed25519 = elliptic.eddsa('ed25519');
var Secp256k1 = elliptic.ec('secp256k1');
var addressCodec = require('../tidepay-address-codec');
var derivePrivateKey = require('./secp256k1').derivePrivateKey;
var accountPublicFromPublicGenerator = require('./secp256k1').accountPublicFromPublicGenerator;
var utils = require('./utils');
var hexToBytes = utils.hexToBytes;
var bytesToHex = utils.bytesToHex;

function generateSeed() {
  var options = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

  assert(!options.entropy || options.entropy.length >= 16, 'entropy too short');
  var entropy = options.entropy ? options.entropy.slice(0, 16) : brorand(16);
  var type = options.algorithm === 'ed25519' ? 'ed25519' : 'secp256k1';
  return addressCodec.encodeSeed(entropy, type);
}

function hash(message) {
  return hashjs.sha512().update(message).digest().slice(0, 32);
}

var secp256k1 = {
  deriveKeypair: function deriveKeypair(entropy, options) {
    var prefix = '00';
    var privateKey = prefix + derivePrivateKey(entropy, options).toString(16, 64).toUpperCase();
    var publicKey = bytesToHex(Secp256k1.keyFromPrivate(privateKey.slice(2)).getPublic().encodeCompressed());
    return { privateKey: privateKey, publicKey: publicKey };
  },
  sign: function sign(message, privateKey) {
    return bytesToHex(Secp256k1.sign(hash(message), hexToBytes(privateKey), { canonical: true }).toDER());
  },
  verify: function verify(message, signature, publicKey) {
    return Secp256k1.verify(hash(message), signature, hexToBytes(publicKey));
  }
};

var ed25519 = {
  deriveKeypair: function deriveKeypair(entropy) {
    var prefix = 'ED';
    var rawPrivateKey = hash(entropy);
    var privateKey = prefix + bytesToHex(rawPrivateKey);
    var publicKey = prefix + bytesToHex(Ed25519.keyFromSecret(rawPrivateKey).pubBytes());
    return { privateKey: privateKey, publicKey: publicKey };
  },
  sign: function sign(message, privateKey) {
    // caution: Ed25519.sign interprets all strings as hex, stripping
    // any non-hex characters without warning
    assert(Array.isArray(message), 'message must be array of octets');
    return bytesToHex(Ed25519.sign(message, hexToBytes(privateKey).slice(1)).toBytes());
  },
  verify: function verify(message, signature, publicKey) {
    return Ed25519.verify(message, hexToBytes(signature), hexToBytes(publicKey).slice(1));
  }
};

function select(algorithm) {
  var methods = { 'ecdsa-secp256k1': secp256k1, ed25519: ed25519 };
  return methods[algorithm];
}

function deriveKeypair(seed, options) {
  var decoded = addressCodec.decodeSeed(seed);
  var algorithm = decoded.type === 'ed25519' ? 'ed25519' : 'ecdsa-secp256k1';
  return select(algorithm).deriveKeypair(decoded.bytes, options);
}

function getAlgorithmFromKey(key) {
  var bytes = hexToBytes(key);
  return bytes.length === 33 && bytes[0] === 0xED ? 'ed25519' : 'ecdsa-secp256k1';
}

function sign(messageHex, privateKey) {
  var algorithm = getAlgorithmFromKey(privateKey);
  return select(algorithm).sign(hexToBytes(messageHex), privateKey);
}

function verify(messageHex, signature, publicKey) {
  var algorithm = getAlgorithmFromKey(publicKey);
  return select(algorithm).verify(hexToBytes(messageHex), signature, publicKey);
}

function deriveAddressFromBytes(publicKeyBytes) {
  return addressCodec.encodeAccountID(utils.computePublicKeyHash(publicKeyBytes));
}

function deriveAddress(publicKey) {
  return deriveAddressFromBytes(hexToBytes(publicKey));
}

function deriveNodeAddress(publicKey) {
  var generatorBytes = addressCodec.decodeNodePublic(publicKey);
  var accountPublicBytes = accountPublicFromPublicGenerator(generatorBytes);
  return deriveAddressFromBytes(accountPublicBytes);
}

module.exports = {
  generateSeed: generateSeed,
  deriveKeypair: deriveKeypair,
  sign: sign,
  verify: verify,
  deriveAddress: deriveAddress,
  deriveNodeAddress: deriveNodeAddress
};