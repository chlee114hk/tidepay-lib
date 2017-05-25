import BlobVaultAPI from './BlobVaultAPI';
import Errors from './Errors'
import Utils from './utils';
import BlobAPI from './blob';
import BlobObj from './BlobObj';
import CustomKeys from './customkeys';

function updateLoginInfo(loginInfo, result, newBlobData = null, newCustomKeys = null) {
  if (!loginInfo) {
    // not logged in, do not update
    return loginInfo;
  }
  let newBlob = loginInfo.blob;
  if (newBlobData) {
    newBlob = { ...newBlob, data: newBlobData };
  }
  let newAuthInfo = newCustomKeys ? newCustomKeys.authInfo : loginInfo.customKeys.authInfo;

  if (result) {
    const { updateFields, deleteFields } = result;
    const hasUpdate = updateFields && Object.keys(updateFields).length > 0;
    const hasDelete = deleteFields && Object.keys(deleteFields).length > 0;
    if (hasDelete) {
      const { blob, authInfo } = deleteFields;
      if (blob) {
        newBlob = { ...newBlob };
        Object.keys(blob).forEach((key) => {
          delete newBlob[key];
        });
      }
      if (authInfo) {
        newAuthInfo = { ...newAuthInfo };
        Object.keys(authInfo).forEach((key) => {
          delete newAuthInfo[key];
        });
      }
    }
    if (hasUpdate) {
      const { blob, authInfo } = updateFields;
      if (blob) {
        newBlob = { ...newBlob, ...blob };
      }
      if (authInfo) {
        newAuthInfo = { ...newAuthInfo, ...authInfo };
      }
    }
  }
  let updatedCustomKeys = newCustomKeys || loginInfo.customKeys;
  if (newAuthInfo !== updatedCustomKeys.authInfo) {
    updatedCustomKeys = CustomKeys.clone(updatedCustomKeys);
    updatedCustomKeys.authInfo = newAuthInfo;
  }
  return { ...loginInfo, blob: newBlob, customKeys: updatedCustomKeys };
}

function checkEmailVerified(authInfo) {
  if (!authInfo.exists) {
    return Promise.reject(new Error('User does not exists.'));
  }
  if (!authInfo.emailVerified) {
    return Promise.reject(new Error('Account has not been verified.'));
  }
  return Promise.resolve();
}

function serializeLoginInfo(loginInfo) {
  return JSON.stringify(loginInfo);
}

function deserializeLoginInfo(str) {
  const strData = JSON.parse(str);
  if (!Object.prototype.hasOwnProperty.call(strData, 'blob')) {
    return strData;
  }

  const {
    blob,
    customKeys,
    ...strDataRest
  } = strData;

  const blobObj = BlobObj.deserialize(blob);
  const customKeysObj = CustomKeys.deserialize(customKeys);

  return { blob: blobObj, customKeys: customKeysObj, ...strDataRest };
}

function serializeCustomKeys(customKeys) {
  return JSON.stringify(customKeys);
}

function deserializeCustomKeys(str) {
  return CustomKeys.deserialize(JSON.parse(str));
}

function cloneLoginInfo(loginInfo) {
  return deserializeLoginInfo(serializeLoginInfo(loginInfo));
}

class VaultClientClass {
  constructor(isunpayrpcURL, callbacks) {
    // initialize vault client
    this.client = new BlobVaultAPI(isunpayrpcURL);
    if (typeof callbacks.readLoginToken !== 'function') {
      throw new Error('readLoginToken callback is not a function');
    }
    if (typeof callbacks.writeLoginToken !== 'function') {
      throw new Error('writeLoginToken callback is not a function');
    }
    if (typeof callbacks.readCustomKeys !== 'function') {
      throw new Error('readLoginToken callback is not a function');
    }
    if (typeof callbacks.writeCustomKeys !== 'function') {
      throw new Error('writeLoginToken callback is not a function');
    }
    this.readLoginTokenCb = callbacks.readLoginToken;
    this.writeLoginTokenCb = callbacks.writeLoginToken;
    this.readCustomKeysCb = callbacks.readCustomKeys;
    this.writeCustomKeysCb = callbacks.writeCustomKeys;
  }

  getLoginToken(options) {
    return this.readLoginTokenCb()
      .then(token => Promise.resolve({ ...options, loginToken: token }));
  }

  setLoginToken(result) {
    const { loginToken, ...rest } = result;
    if (loginToken !== undefined) {
      return this.writeLoginTokenCb(loginToken)
        .then(() => rest);
    }
    return Promise.resolve(rest);
  }

  setAuthLoginToken(resp) {
    const { result } = resp;
    if (result) {
      const { loginToken } = result;
      if (loginToken !== undefined) {
        return this.writeLoginTokenCb(loginToken)
          .then(() => resp);
      }
    }
    return Promise.resolve(resp);
  }

  unlockAccount(unlockSecret, paymentPin) {
    const getEncryptedSecret = (customKeys, loginToken) => {
      const unlockKeysPromise = this.cloneAndDeriveUnlockKey(customKeys, unlockSecret, paymentPin);
      let encryptedSecretPromise;
      if (paymentPin !== undefined) {
        encryptedSecretPromise = unlockKeysPromise
          .then(keys => this.client.getEncryptedSecretBySecretId(keys.authInfo.blobvault, loginToken, keys.secretId));
      } else {
        encryptedSecretPromise = unlockKeysPromise
          .then(keys => this.client.getEncryptedSecretByBlobId(keys.authInfo.blobvault, loginToken, keys.id));
      }
      return Promise.all([
        encryptedSecretPromise,
        unlockKeysPromise,
      ]);
    };

    return Promise.all([
      this.readCustomKeysCb(),
      this.readLoginTokenCb(),
    ])
    .then(([customKeys, loginToken]) => {
      if (!customKeys || !loginToken) {
        return Promise.reject(new Error('No login token or keys'));
      }
      return getEncryptedSecret(customKeys, loginToken);
    })
    .then(([result, customKeys]) => {
      return Promise.all([
        this.setLoginToken(result),
        customKeys,
        this.writeCustomKeysCb(customKeys),
      ]);
    })
    .then(([result, customKeys]) => {
      const { secret } = result;
      const { encrypted_secret } = secret;
      return Promise.all([
        this.client.unlock(encrypted_secret, customKeys),
        customKeys,
      ]);
    })
    .then(([secret, customKeys]) => Promise.resolve({ secret, customKeys }));
  }

  updateBlob(username, loginInfo, newBlob) {
    const _updateBlob = (customKeys) => {
      return this.getLoginToken({
        username,
        blob: newBlob,
      })
      .then((options) => {
        // TODO blob.key
        const { authInfo } = customKeys;
        return checkEmailVerified(authInfo)
          .then(() => this.client.updateBlob(options));
      });
    };

    return _updateBlob(loginInfo.customKeys)
      .then(result => this.setLoginToken(result))
      .then((resolved) => {
        const newLoginInfo = cloneLoginInfo(loginInfo);
        newLoginInfo.blob = newBlob;
        return Promise.resolve({ ...resolved, loginInfo: newLoginInfo });
      });
  }

  changePassword(username, newPassword, loginInfo) {
    const _changePassword = (blob, oldCustomKeys, newCustomKeys) => {
      return this.getLoginToken({
        username,
        blob,
        keys: newCustomKeys,
      })
      .then((options) => {
        // TODO update blob.key
        const { authInfo } = oldCustomKeys;
        return checkEmailVerified(authInfo)
          .then(() => this.client.changePassword(options))
          .then(result => this.setLoginToken(result))
          .then((resolved) => {
            return this.writeCustomKeysCb(newCustomKeys)
              .then(() => Promise.resolve({ newCustomKeys, resolved }));
          });
      });
    };

    return this.createAndDeriveCustomKeys(username, newPassword, loginInfo.customKeys.authInfo)
      .then(newCustomKeys => _changePassword(loginInfo.blob, loginInfo.customKeys, newCustomKeys))
      .then((results) => {
        const { newCustomKeys, resolved } = results;
        const newLoginInfo = cloneLoginInfo(loginInfo);
        if (Object.prototype.hasOwnProperty.call(resolved, 'last_id_change_date')) {
          newLoginInfo.blob.last_id_change_date = resolved.last_id_change_date;
          newLoginInfo.blob.last_id_change_timestamp = resolved.last_id_change_timestamp;
        }
        newLoginInfo.customKeys = newCustomKeys;
        return Promise.resolve({ ...resolved, loginInfo: newLoginInfo });
      });
  }

  changePaymentPin(username, newPaymentPin, loginInfo, secret) {
    const _changePaymentPin = (blob, oldCustomKeys, newCustomKeys) => {
      return this.getLoginToken({
        username,
        masterkey: secret,
        blob,
        keys: newCustomKeys,
        old_secret_id: oldCustomKeys.secretId,
      })
      .then((options) => {
        // TODO update blob.key
        return this.client.changePaymentPin(options)
          .then(result => this.setLoginToken(result))
          .then(resolved => Promise.resolve({ newCustomKeys, resolved }));
      });
    };

    if (!newPaymentPin) {
      return Promise.reject(new Error('Empty payment pin'));
    }

    return this.cloneAndDeriveUnlockKey(loginInfo.customKeys, loginInfo.blob.data.unlock_secret, newPaymentPin)
      .then(newCustomKeys => _changePaymentPin(loginInfo.blob, loginInfo.customKeys, newCustomKeys))
      .then((resp) => {
        const { newCustomKeys, resolved } = resp;
        const { result, ...rest } = resolved;
        const resultLoginInfo = updateLoginInfo(loginInfo, result, undefined, newCustomKeys);
        return this.writeCustomKeysCb(resultLoginInfo.customKeys)
          .then(() => Promise.resolve({ ...rest, loginInfo: resultLoginInfo }));
      });
  }

  authActivateAccount(loginInfo, email, authToken, createAccountToken) {
    const { customKeys, blob } = loginInfo;
    const { data } = blob;

    const activateAccount = (newCustomKeys, unlockSecret) => {
      return this.client.authActivateAccount(newCustomKeys, email, authToken, data, createAccountToken, unlockSecret)
        .then(result => this.setLoginToken(result))
        .then(resolved => Promise.resolve({ newCustomKeys, resolved }));
    };

    const unlockSecret = CustomKeys.createUnlockSecret();
    return this.cloneAndDeriveUnlockKey(customKeys, unlockSecret)
      .then(newCustomKeys => activateAccount(newCustomKeys, unlockSecret))
      .then((resp) => {
        const { newCustomKeys, resolved } = resp;
        const { result, loginToken, newBlobData } = resolved;
        const resultLoginInfo = updateLoginInfo(loginInfo, result, newBlobData, newCustomKeys);
        return this.writeCustomKeysCb(resultLoginInfo.customKeys)
          .then(() => Promise.resolve({ loginInfo: resultLoginInfo, loginToken }));
      });
  }

  authVerifyAccountEmailToken(username, email, emailToken, authToken) {
    return this.client.authVerifyAccountEmailToken(username, email, emailToken, authToken);
  }

  authRegisterAccount(username, password, email, activateLink, domain) {
    const options = {
      username: username,
      password: password,
      email: email,
      activateLink: activateLink,
      domain: domain,
    };
    return this.client.authRegister(options);
  }

  get2FAInfo(loginInfo) {
    return this.getLoginToken({
      blob: loginInfo.blob,
    })
    .then(options => BlobAPI.get2FA(options))
    .then(result => this.setLoginToken(result));
  }

  set2FAInfo(loginInfo, enable, phone) {
    const { blob } = loginInfo;
    return this.getLoginToken({
      enabled: enable,
      phoneNumber: phone.phoneNumber,
      countryCode: phone.countryCode,
      blob,
    })
    .then(options => BlobAPI.set2FA(options))
    .then(result => this.setLoginToken(result))
    .then(result => Promise.resolve({ ...result, loginInfo }));
  }

  authLoginAccount(authInfo, data) {
    const options = {
      url: authInfo.blobvault,
      data,
    };
    console.log('authlogin info', options);
    return this.client.authLogin(options)
      .then(resp => this.setAuthLoginToken(resp));
  }

  logoutAccount(loginInfo) {
    return this.getLoginToken({
      blob: loginInfo.blob,
    })
    .then(options => this.client.logoutAccount(options))
    .then(result => this.setLoginToken(result))
    .then((result) => {
      return this.writeCustomKeysCb(null)
        .then(() => result);
    })
    .catch((err) => {
      return Promise.all([
        this.writeLoginTokenCb(null),
        this.writeCustomKeysCb(null),
      ])
      .then(() => Promise.reject(err));
    });
  }

  createAndDeriveCustomKeys(username, password, inAuthInfo = null) {
    const authInfoPromise = inAuthInfo ? Promise.resolve(inAuthInfo) : this.client.getAuthInfo(username);
    return authInfoPromise
    .then((authInfo) => {
      if (!authInfo.exists) {
        return Promise.reject(new Error('User does not exists.'));
      }
      const customKeys = new CustomKeys(authInfo, password);
      return customKeys.deriveLoginKeys(password);
    });
  }

  cloneAndDeriveUnlockKey(customKeys, unlockSecret, paymentPin) {
    const newCustomKeys = CustomKeys.clone(customKeys);
    return newCustomKeys.deriveUnlockKeys(unlockSecret, paymentPin);
  }

  handleLogin(resp, customKeys) {
    const options = {
      url: customKeys.authInfo.blobvault,
      blob_id: customKeys.id,
      key: customKeys.crypt,
    };
    const blobObj = new BlobObj(options);
    return blobObj.init(resp)
      .then((blob) => {
        // TODO still needed?
        // save for relogin
        const { authInfo } = customKeys;
        this.client.infos[customKeys.id] = authInfo;

        return this.writeCustomKeysCb(customKeys)
          .then(() => {
            return Promise.resolve({
              blob,
              customKeys,
              username: authInfo.username,
            });
          });
      });
  }

  authUnblockAccount(data) {
    const dummyUsername = 'dummy';
    return this.client.getByUsername(dummyUsername)
      .then((authInfo) => {
        const options = {
          url: authInfo.blobvault,
          data,
        };
        return this.client.authUnblockAccount(options)
          .then(resp => this.setAuthLoginToken(resp));
      });
  }

  authRecoverAccount(data) {
    const dummyUsername = 'dummy';
    return this.client.getByUsername(dummyUsername)
      .then((authInfo) => {
        const options = {
          url: authInfo.blobvault,
          data,
        };
        return this.client.authRecoverAccount(options)
          .then(resp => this.setAuthLoginToken(resp));
      });
  }

  authRecoverSecret(data) {
    const dummyUsername = 'dummy';
    return this.client.getByUsername(dummyUsername)
      .then((authInfo) => {
        const options = {
          url: authInfo.blobvault,
          data,
        };
        return this.client.authRecoverSecret(options)
          .then(resp => this.setAuthLoginToken(resp));
      });
  }

  authRequestUpdateEmail(loginInfo, email, hostlink) {
    const { blob, username } = loginInfo;
    return this.getLoginToken({
      url: blob.url,
      blob,
      username,
      data: {
        email,
        hostlink,
      },
    })
    .then(options => this.client.authRequestUpdateEmail(options))
    .then(result => this.setLoginToken(result))
    .then((resp) => {
      const { result, ...restResp } = resp;
      const resultLoginInfo = updateLoginInfo(loginInfo, result);
      return this.writeCustomKeysCb(resultLoginInfo.customKeys)
        .then(() => Promise.resolve({ ...restResp, loginInfo: resultLoginInfo }));
    });
  }

  authVerifyUpdateEmail(loginInfo, email, emailToken, authToken) {
    const { customKeys, blob, username } = loginInfo;
    const recoveryKey = Utils.createRecoveryKey(email);
    const data = {
      email,
      emailToken,
      authToken,
      encrypted_blobdecrypt_key: BlobObj.encryptBlobCrypt(recoveryKey, customKeys.crypt),
    };

    return this.getLoginToken({
      url: blob.url,
      blob,
      username,
      data,
    })
    .then(options => this.client.authVerifyUpdateEmail(options))
    .then(result => this.setLoginToken(result))
    .then((resp) => {
      const { result, ...restResp } = resp;
      const resultLoginInfo = updateLoginInfo(loginInfo, result);
      return this.writeCustomKeysCb(resultLoginInfo.customKeys)
        .then(() => Promise.resolve({ ...restResp, loginInfo: resultLoginInfo }));
    });
  }

  cloneBlob(blob) {
    const { data } = blob;
    // assume no function
    const newData = JSON.parse(JSON.stringify(data));
    return Object.assign(new BlobObj(), blob, { data: newData });
  }

  authRequestUpdatePhone(loginInfo, phone) {
    const _authRequestUpdatePhone = (username, blob) => {
      const { countryCode, phoneNumber } = phone;

      return this.getLoginToken({
        url: blob.url,
        blob,
        username,
        data: {
          countryCode,
          phoneNumber,
          via: 'sms',
        },
      })
      .then(options => this.client.authRequestUpdatePhone(options));
    };

    return _authRequestUpdatePhone(loginInfo.username, loginInfo.blob)
      .then(result => this.setLoginToken(result))
      .then((resp) => {
        const { result, ...restResp } = resp;
        const resultLoginInfo = updateLoginInfo(loginInfo, result);
        return this.writeCustomKeysCb(resultLoginInfo.customKeys)
          .then(() => Promise.resolve({ ...restResp, loginInfo: resultLoginInfo }));
      });
  }

  authVerifyUpdatePhone(loginInfo, phone, phoneToken, authToken, newBlob, hasPaymentPin) {
    const _authVerifyUpdatePhone = (customKeys, blob, username) => {
      const { phoneNumber, countryCode } = phone;
      const recoveryKey = Utils.createSecretRecoveryKey(phone, blob.data.unlock_secret);
      const data = {
        countryCode,
        phoneNumber,
        phoneToken,
        authToken,
        data: newBlob.encrypt(),
        revision: newBlob.revision,
      };
      if (hasPaymentPin) {
        if (!customKeys.unlock) {
          return Promise.reject(new Error('Secret has not been unlocked'));
        }
        data.encrypted_secretdecrypt_key = BlobObj.encryptBlobCrypt(recoveryKey, customKeys.unlock);
      }

      return this.getLoginToken({
        url: blob.url,
        blob,
        username,
        data,
      })
      .then(options => this.client.authVerifyUpdatePhone(options));
    };

    const { customKeys, blob, username } = loginInfo;
    return _authVerifyUpdatePhone(customKeys, blob, username)
      .then(result => this.setLoginToken(result))
      .then((resp) => {
        const { result, ...restResp } = resp;
        const resultLoginInfo = updateLoginInfo(loginInfo, result, newBlob.data);
        return this.writeCustomKeysCb(resultLoginInfo.customKeys)
          .then(() => Promise.resolve({ ...restResp, loginInfo: resultLoginInfo }));
      });
  }

  handleRecovery(resp, email) {
    const { username } = resp;
    return this.client.getByUsername(username)
      .then((authInfo) => {
        const { blob_id, encrypted_blobdecrypt_key } = resp;
        const customKeys = new CustomKeys(authInfo, null);

        customKeys.id = blob_id;
        const recoveryKey = Utils.createRecoveryKey(email);
        try {
          customKeys.crypt = BlobObj.decryptBlobCrypt(recoveryKey, encrypted_blobdecrypt_key);
        } catch (err) {
          console.error('Cannot decrypt by recover key', err);
          return Promise.reject(new Error('Incorrect recover key'));
        }
        return this.client.handleRecovery(resp, customKeys);
      })
      .then((results) => {
        const { blob, customKeys } = results;
        return this.writeCustomKeysCb(customKeys)
          .then(() => {
            return Promise.resolve({
              blob,
              customKeys,
              username: customKeys.authInfo.username,
            });
          });
      });
  }

  handleSecretRecovery(resp, unlockSecret, phone = null) {
    const {
      secret_id,
      encrypted_secret,
      encrypted_secretdecrypt_key,
    } = resp;

    return this.readCustomKeysCb()
      .then((customKeys) => {
        const newCustomKeys = CustomKeys.clone(customKeys);

        if (encrypted_secretdecrypt_key) {
          // payment pin has been set
          const recoveryKey = Utils.createSecretRecoveryKey(phone, unlockSecret);
          try {
            newCustomKeys.secretId = secret_id;
            newCustomKeys.unlock = BlobObj.decryptBlobCrypt(recoveryKey, encrypted_secretdecrypt_key);
            return Promise.resolve(newCustomKeys);
          } catch (err) {
            console.error('Cannot decrypt by recover key', err);
            return Promise.reject(new Error('Incorrect recover key'));
          }
        } else {
          // payment pin has not been set
          return newCustomKeys.deriveUnlockKeys(unlockSecret)
            .then((keys) => {
              newCustomKeys.secretId = secret_id;
              return keys;
            });
        }
      })
      .then((customKeys) => {
        return Promise.all([
          this.client.unlock(encrypted_secret, customKeys),
          customKeys,
        ]);
      })
      .then(([secret, customKeys]) => Promise.resolve({ secret, customKeys }));
  }

  getAuthInfoByEmail(email) {
    return this.client.getByEmail(email);
  }
  getAuthInfoByUsername(username){
    return this.client.getByUsername(username);
  }

  serializeLoginInfo(loginInfo) {
    return serializeLoginInfo(loginInfo);
  }

  deserializeLoginInfo(str) {
    return deserializeLoginInfo(str);
  }

  cloneLoginInfo(loginInfo) {
    return cloneLoginInfo(loginInfo);
  }

  serializeCustomKeys(customKeys) {
    return serializeCustomKeys(customKeys);
  }

  deserializeCustomKeys(str) {
    return deserializeCustomKeys(str);
  }

  blockAccount(username, loginInfo) {
    const { blob } = loginInfo;
    return this.getLoginToken({
      url: blob.url,
      blob_id: blob.id,
      username,
      account_id: blob.data.account_id,
      auth_secret: blob.data.auth_secret,
    })
    .then(options => this.client.blockAccount(options))
    .then(result => this.setLoginToken(result))
    .then((result) => {
      return this.writeCustomKeysCb(null)
        .then(() => Promise.resolve({ ...result, loginInfo: null }));
    })
    .catch((err) => {
      return Promise.all([
        this.writeLoginTokenCb(null),
        this.writeCustomKeysCb(null),
      ])
      .then(() => Promise.reject(err));
    });
  }

  uploadPhotos(loginInfo, formData) {
    return this.getLoginToken({
      blob: loginInfo.blob,
      formData,
    })
    .then(options => this.client.uploadPhotos(options))
    .then(result => this.setLoginToken(result))
    .then((resp) => {
      const newLoginInfo = cloneLoginInfo(loginInfo);
      newLoginInfo.blob.id_photos = resp.id_photos;
      return Promise.resolve({ loginInfo: newLoginInfo });
    });
  }

  addBankAccount(loginInfo, bankAccountInfo, updateBlobDataCallback) {
    const newLoginInfo = cloneLoginInfo(loginInfo);

    updateBlobDataCallback(newLoginInfo.blob.data);

    return this.getLoginToken({
      blob: newLoginInfo.blob,
      bankAccountInfo,
    })
    .then(options => this.client.addBankAccount(options))
    .then(result => this.setLoginToken(result))
    .then(resolved => Promise.resolve({ ...resolved, loginInfo: newLoginInfo }));
  }

  deleteBankAccount(loginInfo, bankAccountInfo, updateBlobDataCallback) {
    const newLoginInfo = cloneLoginInfo(loginInfo);
    updateBlobDataCallback(newLoginInfo.blob.data);

    return this.getLoginToken({
      blob: newLoginInfo.blob,
      bankAccountInfo,
    })
    .then(options => this.client.deleteBankAccount(options))
      .then(result => this.setLoginToken(result))
      .then(resolved => Promise.resolve({ ...resolved, loginInfo: newLoginInfo }));
  }

  getLoginInfo() {
    return Promise.all([
      this.readCustomKeysCb(),
      this.readLoginTokenCb(),
    ])
    .then(([customKeys, loginToken]) => {
      if (!customKeys || !loginToken) {
        return Promise.reject(new Error('No login token or keys'));
      }
      const blobPromise = this.client.getBlob(customKeys.authInfo.blobvault, loginToken, customKeys.id);
      return Promise.all([
        blobPromise,
        customKeys,
      ]);
    })
    .then(([result, customKeys]) => {
      return Promise.all([
        this.setLoginToken(result),
        customKeys,
      ]);
    })
    .then(([result, customKeys]) => {
      const { blob } = result;

      const options = {
        url: customKeys.authInfo.blobvault,
        blob_id: customKeys.id,
        key: customKeys.crypt,
      };
      const blobObj = new BlobObj(options);
      return Promise.all([
        blobObj.init(blob),
        customKeys,
      ]);
    })
    .then(([blobObj, customKeys]) => {
      return Promise.resolve({
        blob: blobObj,
        customKeys,
        username: customKeys.authInfo.username,
      });
    })
    .catch((err) => {
      this.writeLoginTokenCb(null);
      this.writeCustomKeysCb(null);
      return Promise.reject(err);
    });
  }
}

export default VaultClientClass;
export { Utils, Errors };
