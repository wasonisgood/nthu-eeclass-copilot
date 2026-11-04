"use strict";

(function registerEeclassCryptoVault(globalScope) {
    const VAULT_DB_NAME = "eeclassCryptoVaultDB";
    const VAULT_STORE_NAME = "keys";
    const DEVICE_KEY_ID = "aes_gcm_device_key_v1";
    const AUTH_STORAGE_KEY = "eeclassAuthConfig";
    const SESSION_UNLOCK_KEY = "eeclassSessionVaultJwk";
    const PBKDF2_ITERATIONS = 210000;

    function bytesToBase64(bytes) {
        let binary = "";
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        for (let i = 0; i < u8.length; i++) {
            binary += String.fromCharCode(u8[i]);
        }
        return btoa(binary);
    }

    function base64ToBytes(base64) {
        const binary = atob(base64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    function openVaultDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(VAULT_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
                    db.createObjectStore(VAULT_STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function getOrCreateDeviceKey() {
        const db = await openVaultDB();
        const existingKey = await new Promise((resolve) => {
            const tx = db.transaction(VAULT_STORE_NAME, "readonly");
            const req = tx.objectStore(VAULT_STORE_NAME).get(DEVICE_KEY_ID);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        });
        if (existingKey) {
            return existingKey;
        }
        // Generate a non-extractable 256-bit AES-GCM CryptoKey
        const newKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
        await new Promise((resolve, reject) => {
            const tx = db.transaction(VAULT_STORE_NAME, "readwrite");
            tx.objectStore(VAULT_STORE_NAME).put(newKey, DEVICE_KEY_ID);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return newKey;
    }

    async function derivePinKey(pin, saltBytes, extractableForSession = true) {
        const encoder = new TextEncoder();
        const baseKey = await crypto.subtle.importKey(
            "raw",
            encoder.encode(pin),
            "PBKDF2",
            false,
            ["deriveKey"]
        );
        return await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: saltBytes,
                iterations: PBKDF2_ITERATIONS,
                hash: "SHA-256",
            },
            baseKey,
            { name: "AES-GCM", length: 256 },
            extractableForSession,
            ["encrypt", "decrypt"]
        );
    }

    async function saveUnlockedPinKeyToSession(cryptoKey) {
        if (!chrome.storage?.session) {
            return;
        }
        const jwk = await crypto.subtle.exportKey("jwk", cryptoKey);
        await chrome.storage.session.set({ [SESSION_UNLOCK_KEY]: jwk });
    }

    async function loadUnlockedPinKeyFromSession() {
        if (!chrome.storage?.session) {
            return null;
        }
        const res = await chrome.storage.session.get([SESSION_UNLOCK_KEY]);
        const jwk = res?.[SESSION_UNLOCK_KEY];
        if (!jwk) {
            return null;
        }
        try {
            return await crypto.subtle.importKey(
                "jwk",
                jwk,
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"]
            );
        }
        catch {
            return null;
        }
    }

    async function clearSessionPinKey() {
        if (!chrome.storage?.session) {
            return;
        }
        await chrome.storage.session.remove([SESSION_UNLOCK_KEY]);
    }

    async function encryptSecrets({ password = "", cid = "" }, masterPin = "") {
        const payloadJson = JSON.stringify({
            password: String(password ?? ""),
            cid: String(cid ?? ""),
        });
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(payloadJson);

        const trimmedPin = String(masterPin ?? "").trim();
        if (trimmedPin !== "") {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const pinKey = await derivePinKey(trimmedPin, salt, true);
            await saveUnlockedPinKeyToSession(pinKey);
            const cipherBuffer = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                pinKey,
                encoded
            );
            return {
                version: 1,
                mode: "pbkdf2_pin",
                iv: bytesToBase64(iv),
                salt: bytesToBase64(salt),
                ciphertext: bytesToBase64(new Uint8Array(cipherBuffer)),
            };
        }

        await clearSessionPinKey();
        const deviceKey = await getOrCreateDeviceKey();
        const cipherBuffer = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            deviceKey,
            encoded
        );
        return {
            version: 1,
            mode: "device_key",
            iv: bytesToBase64(iv),
            ciphertext: bytesToBase64(new Uint8Array(cipherBuffer)),
        };
    }

    async function decryptSecrets(vaultRecord, providedPin = "") {
        if (!vaultRecord || !vaultRecord.ciphertext || !vaultRecord.iv) {
            return { password: "", cid: "", locked: false };
        }
        const iv = base64ToBytes(vaultRecord.iv);
        const ciphertext = base64ToBytes(vaultRecord.ciphertext);

        let key = null;
        if (vaultRecord.mode === "pbkdf2_pin") {
            const trimmedPin = String(providedPin ?? "").trim();
            if (trimmedPin !== "" && vaultRecord.salt) {
                const salt = base64ToBytes(vaultRecord.salt);
                key = await derivePinKey(trimmedPin, salt, true);
            }
            else {
                key = await loadUnlockedPinKeyFromSession();
            }
            if (!key) {
                return { password: "", cid: "", locked: true };
            }
        }
        else {
            key = await getOrCreateDeviceKey();
        }

        try {
            const plainBuffer = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv },
                key,
                ciphertext
            );
            if (vaultRecord.mode === "pbkdf2_pin" && String(providedPin ?? "").trim() !== "") {
                await saveUnlockedPinKeyToSession(key);
            }
            const parsed = JSON.parse(new TextDecoder().decode(plainBuffer));
            return {
                password: String(parsed?.password ?? ""),
                cid: String(parsed?.cid ?? ""),
                locked: false,
            };
        }
        catch {
            return {
                password: "",
                cid: "",
                locked: vaultRecord.mode === "pbkdf2_pin",
                decryptError: true,
            };
        }
    }

    async function migratePlaintextAuthConfigIfNeeded() {
        const res = await chrome.storage.local.get([AUTH_STORAGE_KEY]);
        const config = res?.[AUTH_STORAGE_KEY];
        if (!config) {
            return null;
        }
        if (
            (typeof config.password === "string" && config.password !== "") ||
            (typeof config.cid === "string" && config.cid !== "")
        ) {
            const vault = await encryptSecrets({
                password: config.password ?? "",
                cid: config.cid ?? "",
            });
            const migrated = {
                autoLogin: config.autoLogin !== false,
                keep: Boolean(config.keep),
                id: config.id ?? "",
                crossSchool: Boolean(config.crossSchool),
                school: config.school ?? "",
                hasSavedPassword: Boolean(config.password),
                hasSavedCid: Boolean(config.cid),
                vault,
            };
            await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: migrated });
            return migrated;
        }
        return config;
    }

    async function saveAuthConfigSecurely({
        autoLogin = true,
        keep = false,
        id = "",
        password = "",
        crossSchool = false,
        school = "",
        cid = "",
        masterPin = "",
    }) {
        const hasSecrets = Boolean(password || cid);
        const vault = hasSecrets
            ? await encryptSecrets({ password, cid }, masterPin)
            : null;

        const record = {
            autoLogin: Boolean(autoLogin),
            keep: Boolean(keep),
            id: String(id ?? "").trim(),
            crossSchool: Boolean(crossSchool),
            school: String(school ?? ""),
            hasSavedPassword: Boolean(password),
            hasSavedCid: Boolean(cid),
            vault,
        };
        await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: record });
        return record;
    }

    async function loadDecryptedAuthConfig(providedPin = "") {
        const config = (await migratePlaintextAuthConfigIfNeeded()) ?? {};
        if (!config.vault) {
            return {
                autoLogin: config.autoLogin !== false,
                keep: Boolean(config.keep),
                id: config.id ?? "",
                password: "",
                crossSchool: Boolean(config.crossSchool),
                school: config.school ?? "",
                cid: "",
                vaultMode: "none",
                locked: false,
            };
        }
        const decrypted = await decryptSecrets(config.vault, providedPin);
        return {
            autoLogin: config.autoLogin !== false,
            keep: Boolean(config.keep),
            id: config.id ?? "",
            password: decrypted.password,
            crossSchool: Boolean(config.crossSchool),
            school: config.school ?? "",
            cid: decrypted.cid,
            vaultMode: config.vault.mode || "device_key",
            locked: Boolean(decrypted.locked),
            decryptError: Boolean(decrypted.decryptError),
        };
    }

    // ==================== 圖書館帳密（與 eeclass 帳密分開儲存，同樣使用 AES-GCM 加密） ====================
    const LIBRARY_AUTH_STORAGE_KEY = "libraryAuthConfig";

    async function saveLibraryAuthSecurely({
        id = "",
        password = "",
        autoLogin = true,
        masterPin = "",
    } = {}) {
        const vault = password
            ? await encryptSecrets({ password, cid: "" }, masterPin)
            : null;

        const record = {
            autoLogin: Boolean(autoLogin),
            id: String(id ?? "").trim(),
            hasSavedPassword: Boolean(password),
            vault,
        };
        await chrome.storage.local.set({ [LIBRARY_AUTH_STORAGE_KEY]: record });
        return record;
    }

    async function loadDecryptedLibraryAuthConfig(providedPin = "") {
        const res = await chrome.storage.local.get([LIBRARY_AUTH_STORAGE_KEY]);
        const config = res?.[LIBRARY_AUTH_STORAGE_KEY] ?? {};
        if (!config.vault) {
            return {
                autoLogin: config.autoLogin !== false,
                id: config.id ?? "",
                password: "",
                vaultMode: "none",
                locked: false,
            };
        }
        const decrypted = await decryptSecrets(config.vault, providedPin);
        return {
            autoLogin: config.autoLogin !== false,
            id: config.id ?? "",
            password: decrypted.password,
            vaultMode: config.vault.mode || "device_key",
            locked: Boolean(decrypted.locked),
        };
    }

    globalScope.EECLASS_CRYPTO_VAULT = {
        encryptSecrets,
        decryptSecrets,
        migratePlaintextAuthConfigIfNeeded,
        saveAuthConfigSecurely,
        loadDecryptedAuthConfig,
        clearSessionPinKey,
        saveLibraryAuthSecurely,
        loadDecryptedLibraryAuthConfig,
        LIBRARY_AUTH_STORAGE_KEY,
    };
})(globalThis);
