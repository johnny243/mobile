import {Platform} from 'react-native';
import FlagSecure from 'react-native-flag-secure-android';
import FingerprintScanner from 'react-native-fingerprint-scanner';

import SF from './sfjs/sfjs'
import ModelManager from './sfjs/modelManager'
import Storage from './sfjs/storageManager'
import AlertManager from "@SFJS/alertManager"
import Keychain from "./keychain"
import SNReactNative from 'standard-notes-rn';

let OfflineParamsKey = "pc_params";
let BiometricsPrefs = "biometrics_prefs";
let FirstRunKey = "first_run";
let StorageEncryptionKey = "storage_encryption";

export default class KeysManager {

  static instance = null;

  static get() {
    if (this.instance == null) {
      this.instance = new KeysManager();
    }

    return this.instance;
  }

  constructor() {
    this.biometricPrefs = {};
    this.accountRelatedStorageKeys = ["auth_params", "user"];
  }

  async runPendingMigrations() {
    const migrationName = "10102019KeychainToStorage";
    if((await Storage.get().getItem(migrationName)) == null) {
      console.log("Running migration", migrationName);
      await this.migrateKeychainPrefsToStorage();
      await Storage.get().setItem(migrationName, "true");
    }
  }

  async migrateKeychainPrefsToStorage() {
    // Move JWT from keychain to user (we want to go away on app uninstall rather than persist)
    let jwt = this.activeKeys() && this.activeKeys().jwt;
    if(jwt) {
      this.user.jwt = jwt;
      this.activeKeys().jwt = null;
      await this.saveUser(this.user);
    }

    // Move biometrics preference to storage
    if(this.legacy_fingerprint) {
      this.biometricPrefs.enabled = this.legacy_fingerprint.enabled;
      this.biometricPrefs.timing = this.legacy_fingerprint.timing;
      await this.saveBiometricPrefs();
      this.legacy_fingerprint = null;
    }

    if(jwt || this.legacy_fingerprint) {
      await this.persistKeysToKeychain();
    }
  }

  async loadInitialData() {
    let storageKeys = [
      "auth_params",
      "user",
      OfflineParamsKey,
      FirstRunKey,
      StorageEncryptionKey,
      BiometricsPrefs
    ];

    /*
      We only want to call this once per app session. On Android, the App.js component may be unmounted
      on hardware back button press. When it constructs again, it calls this function, resetting our values for offlineKeys
      which we don't want to change, since on authentication, they are set by the passcode unlock success function.
     */
    if(this.loadInitialDataPromise) {
      return this.loadInitialDataPromise;
    }

    this.loadInitialDataPromise = Promise.all([

      Keychain.getKeys().then((keys) => {
        if(keys) {
          this.parseKeychainValue(keys);
        }
      }),

      Storage.get().getMultiItems(storageKeys).then(async (items) => {
        this.missingFirstRunKey = items[FirstRunKey] === null || items[FirstRunKey] === undefined;

        // auth params
        var authParams = items.auth_params;
        if(authParams) {
          this.accountAuthParams = JSON.parse(authParams);
        }

        let biometricPrefs = items[BiometricsPrefs];
        if(biometricPrefs) {
          this.biometricPrefs = JSON.parse(biometricPrefs);
        }

        // offline params
        var pcParams = items[OfflineParamsKey];
        if(pcParams) {
          this.offlineAuthParams = JSON.parse(pcParams);
        }

        // storage encryption
        if(items[StorageEncryptionKey] == null || items[StorageEncryptionKey] == undefined) {
          // default is true
          // Note that this defaults to true, but doesn't dictate if it's actually applied.
          // For example, when you first install the app and have no account and no passcode,
          // There will be no encryption source available. In the syncManager key request handler,
          // we check if this flag is true and if there are active keys. We use this to indicate that
          // when keys become available, we want storage encryption to be enabled by default.
          this._storageEncryptionEnabled = true;
        } else {
          this._storageEncryptionEnabled = JSON.parse(items[StorageEncryptionKey]) == true;
        }

        // user
        var user = items.user;
        if(user) {
          this.user = JSON.parse(user);
        } else {
          this.user = {};
        }
      })
    ]).then(async () => {
      // We only want to run migrations in unlocked app state. If account keys are present, run now,
      // otherwise wait until offline keys have been set so that account keys are decrypted.
      if(!this.encryptedAccountKeys) {
        return this.runPendingMigrations();
      }
    })

    return this.loadInitialDataPromise;
  }

  async needsWipe() {
    // Needs wipe if has keys but no data. However, since "no data" can be incorrectly reported by underlying
    // AsyncStorage failures, we want to confirm with the user before deleting anything.

    let hasKeys = this.activeKeys() != null;
    let noData = this.missingFirstRunKey === true;
    return hasKeys && noData;
  }

  async markApplicationAsRan() {
    return Storage.get().setItem(FirstRunKey, "false");
  }

  async wipeData() {
    // On iOS, keychain data is persisted between installs/uninstalls. (https://stackoverflow.com/questions/4747404/delete-keychain-items-when-an-app-is-uninstalled)
    // This prevents the user from deleting the app and reinstalling if they forgot their local passocde
    // or if fingerprint scanning isn't working. By deleting all data on first run, we allow the user to reset app
    // state after uninstall.

    console.log("===Wiping Data===");

    return AlertManager.get().confirm({
      title: "Previous Installation",
      text: `We've detected a previous installation of Standard Notes based on your keychain data. You must wipe all data from previous installation to continue.\n\nIf you're seeing this message in error, it might mean we're having issues loading your local database. Please restart the app and try again.`,
      confirmButtonText: "Delete Local Data",
      cancelButtonText: "Quit App",
      onConfirm: async () => {
        await Storage.get().clear();
        await Keychain.clearKeys()
        this.parseKeychainValue(null);
        this.accountAuthParams = null;
        this.user = null;
      },
      onCancel: () => {
        SNReactNative.exitApp();
      }
    })
  }

  /*
    If a user was using the app offline without an account, and had a local passcode, then did
    an iCloud restore, then they will have saved auth params (saved to storage),
    but no keychain values (not saved to storage).

    In this case, we want to present a recovery wizard where they can attempt values of their local passcode,
    and see if it yeilds successful decryption. We can't verify whether the passcode they enter is correct,
    since the valid hash value is stored in the keychain as well.
   */
  shouldPresentKeyRecoveryWizard() {
    if(!this.accountAuthParams && this.offlineAuthParams && !this.offlineKeys) {
      return true;
    } else {
      return false;
    }
  }

  /*
    We need to register local storage keys, so that when we want to sign out, we don't accidentally
    clear internal keys, like first_run. (If you accidentally delete the first_run key when you sign out,
    then the next time you sign in and refresh, it will treat it as a new run, and delete all data.)
  */
  registerAccountRelatedStorageKeys(storageKeys) {
    this.accountRelatedStorageKeys = _.uniq(this.accountRelatedStorageKeys.concat(storageKeys));
  }

  parseKeychainValue(keys) {
    if(keys) {
      this.offlineKeys = keys.offline;
      if(this.offlineKeys) {
        this.passcodeTiming = this.offlineKeys.timing;
      }

      // Legacy, migrated to Storage
      if(keys.fingerprint) {
        this.legacy_fingerprint = keys.fingerprint;
        this.biometricPrefs.enabled = keys.fingerprint.enabled;
        this.biometricPrefs.timing = keys.fingerprint.timing;
        delete keys.fingerprint;
      }

      if(keys.encryptedAccountKeys) {
        // We won't handle this case here. We'll wait until setOfflineKeys is called
        // by whoever authenticates local passcode. That's when we actually get the offline
        // keys we can use to decrypt encryptedAccountKeys
        this.encryptedAccountKeys = keys.encryptedAccountKeys;
      } else {
        this.accountKeys = _.omit(keys, ["offline"]);
        if(_.keys(this.accountKeys).length == 0) {
          this.accountKeys = null;
        }
      }
    } else {
      this.offlineKeys = null;
      this.passcodeTiming = null;
      this.accountKeys = null;
    }
  }

  // what we should write to keychain
  async generateKeychainStoreValue() {
    let value = {};

    if(this.accountKeys) {
      // If offline local passcode keys are available, use that to encrypt account keys
      // Don't encrypt offline pw because then we don't be able to verify passcode
      if(this.offlineKeys) {
        var encryptedKeys = new SFItem();
        encryptedKeys.uuid = await SF.get().crypto.generateUUID();
        encryptedKeys.content_type = "SN|Mobile|EncryptedKeys"
        encryptedKeys.content.accountKeys = this.accountKeys;
        var params = new SFItemParams(encryptedKeys, this.offlineKeys, this.offlineAuthParams);
        let results = await params.paramsForSync();
        value.encryptedAccountKeys = results;
      } else {
        _.merge(value, this.accountKeys);
      }
    }

    if(this.offlineKeys) {
      _.merge(value, {offline: {pw: this.offlineKeys.pw, timing: this.passcodeTiming}});
    }

    return value;
  }

  async persistKeysToKeychain() {
    // This funciton is called when changes are made to authentication state
    this.updateScreenshotPrivacy();
    let value = await this.generateKeychainStoreValue();
    return Keychain.setKeys(value);
  }

  updateScreenshotPrivacy(enabled) {
    if(Platform.OS == "ios") {
      return;
    }

    var hasImmediatePasscode = this.hasOfflinePasscode() && this.passcodeTiming == "immediately";
    var hasImmedateBiometrics = this.hasBiometrics() && this.biometricPrefs.timing == "immediately";
    var enabled = hasImmediatePasscode || hasImmedateBiometrics;

    if(enabled) {
      FlagSecure.activate();
    } else {
      FlagSecure.deactivate();
    }
  }

  async persistAccountKeys(keys) {
    this.accountKeys = keys;
    return this.persistKeysToKeychain();
  }

  async saveUser(user) {
    this.user = user;
    return Storage.get().setItem("user", JSON.stringify(user));
  }

  /* The keys to use for encryption. If user is signed in, use those keys, otherwise use offline keys */
  activeKeys() {
    if(this.hasAccountKeys()) {
      return this.accountKeys;
    } else {
      return this.offlineKeys;
    }
  }

  hasAccountKeys() {
    return this.accountKeys && this.accountKeys.mk != null;
  }

  isOfflineEncryptionEnabled() {
    var keys = this.activeKeys();
    return keys && keys.mk !== null && this.isStorageEncryptionEnabled();
  }

  encryptionSource() {
    if(this.accountKeys && this.accountKeys.mk !== null) {
      return "account";
    } else if(this.offlineKeys && this.offlineKeys.mk !== null) {
      return "offline";
    } else {
      return null;
    }
  }

  async clearAccountKeysAndData() {
    Keychain.clearKeys();
    this.accountKeys = null;
    this.accountAuthParams = null;
    this.user = null;
    await Storage.get().clearKeys(this.accountRelatedStorageKeys);
    return this.persistKeysToKeychain();
  }

  jwt() {
    return this.user && this.user.jwt;
  }




  // Storage Encryption

  async enableStorageEncryption() {
    this._storageEncryptionEnabled = true;
    return Storage.get().setItem(StorageEncryptionKey, JSON.stringify(this._storageEncryptionEnabled));
  }

  async disableStorageEncryption() {
    this._storageEncryptionEnabled = false;
    return Storage.get().setItem(StorageEncryptionKey, JSON.stringify(this._storageEncryptionEnabled));
  }

  isStorageEncryptionEnabled() {
    // See comment in loadInitialData regarding why the value of this._storageEncryptionEnabled is not sufficient
    // to determine whether it's actually enabled
    return this._storageEncryptionEnabled && this.activeKeys();
  }



  // Auth Params

  async setAccountAuthParams(authParams) {
    this.accountAuthParams = authParams;
    await Storage.get().setItem("auth_params", JSON.stringify(authParams));

    if(this.offlineAuthParams && !this.offlineKeys) {
      /*
        This can happen if:
        1. You are signed into an account and have a local passcode
        2. You do an iCloud restore
        3. Your Keychain is wiped, but storage isn't, so offlineAuthParams still exists.
        4. You restore your account by signing in. At this point, no local passcode will actually be set.
           The value of offlineAuthParams is stale. We want to delete it.
      */

      console.log("offlineAuthParams is stale, deleting");
      await Storage.get().removeItem(OfflineParamsKey);
    }
  }

  async setOfflineAuthParams(authParams) {
    this.offlineAuthParams = authParams;
    return Storage.get().setItem(OfflineParamsKey, JSON.stringify(authParams));
  }

  defaultProtocolVersionForKeys(keys) {
    if(keys && keys.ak) {
      // If there's no version stored, and there's an ak, it has to be 002. Newer versions would have thier version stored in authParams.
      return "002";
    } else {
      return "001";
    }
  }

  activeAuthParams() {
    if(this.accountKeys) {
      var params = this.accountAuthParams;
      if(params && !params.version) {
        params.version = this.defaultProtocolVersionForKeys(this.accountKeys);
      }
      return params;
    } else if(this.offlineAuthParams) {
      var params = this.offlineAuthParams;
      if(params && !params.version) {
        params.version = this.defaultProtocolVersionForKeys(this.offlineKeys);
      }
      return params;
    }
  }



  // User

  getUserEmail() {
    return this.user && this.user.email;
  }



  // Local Security

  async clearOfflineKeysAndData(force = false) {
    // make sure user is authenticated before performing this step
    if(this.offlineKeys && !this.offlineKeys.mk && !force) {
      alert("Unable to remove passcode. Make sure you are properly authenticated and try again.");
      return false;
    }
    this.offlineKeys = null;
    this.offlineAuthParams = null;
    await Storage.get().removeItem(OfflineParamsKey);
    return this.persistKeysToKeychain();
  }

  async persistOfflineKeys(keys) {
    this.setOfflineKeys(keys);
    if(!this.passcodeTiming) {
      this.passcodeTiming = "on-quit";
    }
    return this.persistKeysToKeychain();
  }

  async setOfflineKeys(keys) {
    // offline keys are ephemeral and should not be stored anywhere
    this.offlineKeys = keys;

    // Check to see if encryptedAccountKeys need decrypting
    if(this.encryptedAccountKeys) {
      // Decrypt and set
      await SFJS.itemTransformer.decryptItem(this.encryptedAccountKeys, this.offlineKeys);
      // itemTransformer modifies in place. this.encryptedAccountKeys should now be decrypted
      let decryptedKeys = new SFItem(this.encryptedAccountKeys);
      if(decryptedKeys.errorDecrypting) {
        console.error("Fatal: Error decrypting account keys");
      } else {
        this.accountKeys = decryptedKeys.content.accountKeys;
        this.encryptedAccountKeys = null;
        await this.runPendingMigrations();
      }
    }
  }

  offlinePasscodeHash() {
    return this.offlineKeys ? this.offlineKeys.pw : null;
  }

  hasOfflinePasscode() {
    return this.offlineKeys && this.offlineKeys.pw !== null;
  }

  hasBiometrics() {
    return this.biometricPrefs.enabled;
  }

  async setPasscodeTiming(timing) {
    this.passcodeTiming = timing;
    return this.persistKeysToKeychain();
  }

  async setBiometricsTiming(timing) {
    this.biometricPrefs.timing = timing;
    return this.saveBiometricPrefs();
  }

  async enableBiometrics() {
    this.biometricPrefs.enabled = true;
    if(!this.biometricPrefs.timing) {
      this.biometricPrefs.timing = "on-quit";
    }
    return this.saveBiometricPrefs();
  }

  async disableBiometrics() {
    this.biometricPrefs.enabled = false;
    return this.saveBiometricPrefs();
  }

  async saveBiometricPrefs() {
    return Storage.get().setItem(BiometricsPrefs, JSON.stringify(this.biometricPrefs));
  }

  getPasscodeTimingOptions() {
    return [
      {title: "Immediately", key: "immediately", selected: this.passcodeTiming == "immediately"},
      {title: "On Quit", key: "on-quit", selected: this.passcodeTiming == "on-quit"},
    ]
  }

  getBiometricsTimingOptions() {
    return [
      {title: "Immediately", key: "immediately", selected: this.biometricPrefs.timing == "immediately"},
      {title: "On Quit", key: "on-quit", selected: this.biometricPrefs.timing == "on-quit"},
    ]
  }

  static getDeviceBiometricsAvailability(callback) {
    let isAndroid = Platform.OS == "android";
    if(__DEV__) {
      if(isAndroid) {
        callback(true, "touch", "Fingerprint (Dev)");
      } else {
        callback(true, "face", "Face ID");
      }
      return;
    }
    FingerprintScanner.isSensorAvailable().then((type) => {
      var noun = (!type || type == "touch") ? "Fingerprint" : "Face ID";
      callback(true, type, noun);
    }).catch((error) => {
      callback(false);
    })
  }

}
