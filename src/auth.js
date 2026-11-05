// src/auth.js — autenticación local (sin backend, sin servidor).
// La app es 100% local: no hay email ni SMS para "olvidé mi contraseña".
// El reset funciona con un CÓDIGO DE RECUPERACIÓN de un solo uso (igual que
// un backup code de 2FA), generado al registrarse y mostrado UNA SOLA VEZ.
// Solo se guarda su hash (igual que la contraseña), nunca el código en claro.
// Funciones puras + Web Crypto (PBKDF2-SHA256); no dependen del DOM, por lo
// que corren igual en el navegador y en Node (smoke tests).

import { db } from './db.js';

export const AUTH_KEY = 'gastosdiarios-auth-v1';
const ITERATIONS = 150000;
const KEY_BYTES = 32;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I (ambiguos)

function randomBytes(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function pbkdf2Hex(secret, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial, KEY_BYTES * 8
  );
  return toHex(new Uint8Array(bits));
}

async function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = await pbkdf2Hex(secret, salt, ITERATIONS);
  return { hash, salt: toHex(salt), iterations: ITERATIONS };
}

// Comparación en tiempo constante (ambos hex de la misma longitud fija).
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySecret(secret, record) {
  if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false;
  const hash = await pbkdf2Hex(secret, fromHex(record.salt), record.iterations || ITERATIONS);
  return timingSafeEqualHex(hash, record.hash);
}

function generateRecoveryCode() {
  const groups = [];
  for (let g = 0; g < 3; g++) {
    const bytes = randomBytes(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    groups.push(s);
  }
  return groups.join('-'); // ej. "7K4M-QX9P-2VYH"
}

function normalizeRecoveryInput(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function readAccount() {
  try {
    const raw = db.get(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeAccount(account) {
  return db.set(AUTH_KEY, JSON.stringify(account));
}

export function hasAccount() {
  return readAccount() !== null;
}

export function accountUsername() {
  return readAccount()?.username ?? null;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

export function validateUsername(username) {
  return USERNAME_RE.test(String(username || '').trim());
}

export function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

// Crea la cuenta local. Devuelve { ok, error, recoveryCode } — el código
// viaja SOLO en esta respuesta (para mostrarlo una vez); nunca se persiste
// en claro.
export async function register(username, password) {
  const u = String(username || '').trim();
  if (!validateUsername(u)) {
    return { ok: false, error: 'El usuario debe tener 3-30 caracteres (letras, números, ".", "_", "-").' };
  }
  if (!validatePassword(password)) {
    return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
  }
  if (hasAccount()) return { ok: false, error: 'Ya existe una cuenta en este dispositivo.' };

  const passwordHash = await hashSecret(password);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await hashSecret(normalizeRecoveryInput(recoveryCode));
  const account = { username: u, passwordHash, recoveryHash, createdAt: new Date().toISOString() };
  if (!writeAccount(account)) return { ok: false, error: 'No se pudo guardar la cuenta en este dispositivo.' };
  return { ok: true, recoveryCode };
}

export async function login(username, password) {
  const account = readAccount();
  if (!account) return { ok: false, error: 'No hay una cuenta registrada en este dispositivo.' };
  if (String(username || '').trim().toLowerCase() !== account.username.toLowerCase()) {
    return { ok: false, error: 'Usuario o contraseña incorrectos.' };
  }
  const valid = await verifySecret(password, account.passwordHash);
  if (!valid) return { ok: false, error: 'Usuario o contraseña incorrectos.' };
  return { ok: true };
}

// Verifica el código de recuperación y, si es válido, fija la nueva
// contraseña Y emite un código de recuperación nuevo (el anterior queda
// invalidado: de un solo uso, como un backup code de 2FA).
export async function resetWithRecoveryCode(recoveryCode, newPassword) {
  const account = readAccount();
  if (!account) return { ok: false, error: 'No hay una cuenta registrada en este dispositivo.' };
  if (!validatePassword(newPassword)) {
    return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
  }
  const valid = await verifySecret(normalizeRecoveryInput(recoveryCode), account.recoveryHash);
  if (!valid) return { ok: false, error: 'Código de recuperación incorrecto.' };

  const passwordHash = await hashSecret(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  const recoveryHash = await hashSecret(normalizeRecoveryInput(newRecoveryCode));
  const updated = { ...account, passwordHash, recoveryHash, updatedAt: new Date().toISOString() };
  if (!writeAccount(updated)) return { ok: false, error: 'No se pudo guardar el cambio en este dispositivo.' };
  return { ok: true, recoveryCode: newRecoveryCode };
}

// Cambia la contraseña estando autenticado (desde Configuración, no desde
// el flujo de "olvidé mi contraseña"). No rota el código de recuperación.
export async function changePassword(currentPassword, newPassword) {
  const account = readAccount();
  if (!account) return { ok: false, error: 'No hay una cuenta registrada en este dispositivo.' };
  if (!validatePassword(newPassword)) {
    return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
  }
  const valid = await verifySecret(currentPassword, account.passwordHash);
  if (!valid) return { ok: false, error: 'La contraseña actual no es correcta.' };
  const passwordHash = await hashSecret(newPassword);
  const updated = { ...account, passwordHash, updatedAt: new Date().toISOString() };
  if (!writeAccount(updated)) return { ok: false, error: 'No se pudo guardar el cambio en este dispositivo.' };
  return { ok: true };
}

// Elimina la cuenta local de este dispositivo. NO borra los datos
// financieros (eso es resetData() en app.js); solo el usuario/contraseña.
export function removeLocalAccount() {
  return db.remove(AUTH_KEY);
}
