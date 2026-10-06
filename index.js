// ================= index.js v4.0 — Full Backend (Existing 100% preserved + Advanced Features) =================
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');
process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone: ${process.env.TZ}`);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ============================================================
//  FCM INIT
// ============================================================
let fcmReady = false;
try {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  if (projectId && privateKey && clientEmail) {
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert({ projectId, privateKey, clientEmail }) });
    fcmReady = true;
    console.log('🔥 Firebase Admin initialized — push notifications READY');
  } else {
    console.warn('⚠️ FCM env vars missing — push notifications DISABLED');
    console.warn(`   projectId=${!!projectId} | privateKey=${!!privateKey} | clientEmail=${!!clientEmail}`);
  }
} catch (e) { console.error('❌ Firebase Admin init failed:', e.message); fcmReady = false; }

async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!fcmReady || !fcmToken) return { ok: false, reason: !fcmReady ? 'not-ready' : 'no-token' };
  try {
    const message = {
      token: fcmToken,
      data: Object.assign({ title, body, icon: '/icon-192.png' }, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))),
      webpush: { headers: { Urgency: 'high', TTL: '86400' }, notification: { title, body, vibrate: [200, 100, 200], requireInteraction: true }, fcmOptions: { link: '/' } },
      android: { priority: 'high', ttl: 86400000 }
    };
    const resp = await admin.messaging().send(message);
    return { ok: true, messageId: resp };
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') return { ok: false, reason: 'invalid-token', code: e.code };
    console.warn('⚠️ FCM send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

async function sendPushToMany(tokens, title, body, data = {}) {
  if (!fcmReady || !tokens || !tokens.length) return { ok: false, sent: 0, failed: 0 };
  const valid = tokens.filter(t => t && typeof t === 'string' && t.length > 20);
  if (!valid.length) return { ok: false, sent: 0, failed: 0 };
  try {
    const message = {
      tokens: valid,
      data: Object.assign({ title, body, icon: '/icon-192.png' }, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))),
      webpush: { headers: { Urgency: 'high', TTL: '86400' }, notification: { title, body, vibrate: [200, 100, 200], requireInteraction: true }, fcmOptions: { link: '/' } },
      android: { priority: 'high', ttl: 86400000 }
    };
    const resp = await admin.messaging().sendEachForMulticast(message);
    console.log(`📤 [FCM-BULK] "${title}" → sent=${resp.successCount} failed=${resp.failureCount}`);
    const invalidTokens = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) invalidTokens.push(valid[i]);
      }
    });
    if (invalidTokens.length) {
      try { await User.updateMany({ fcmToken: { $in: invalidTokens } }, { $set: { fcmToken: null } }); console.log(`🧹 [FCM] Cleaned ${invalidTokens.length} invalid token(s)`); } catch (e) {}
    }
    return { ok: true, sent: resp.successCount, failed: resp.failureCount };
  } catch (e) { console.warn('⚠️ FCM bulk send failed:', e.message); return { ok: false, sent: 0, failed: valid.length, reason: e.message }; }
}

async function sendPushToAllStudents(title, body, data = {}) {
  if (!fcmReady) return { ok: false, sent: 0, failed: 0, reason: 'fcm-not-ready' };
  try {
    const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('fcmToken').lean();
    const tokens = students.map(s => s.fcmToken).filter(Boolean);
    if (!tokens.length) return { ok: false, sent: 0, failed: 0, reason: 'no-tokens' };
    return await sendPushToMany(tokens, title, body, data);
  } catch (e) { console.warn('⚠️ FCM all-students failed:', e.message); return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

async function sendPushToRole(role, title, body, data = {}) {
  if (!fcmReady) return { ok: false, sent: 0, failed: 0, reason: 'fcm-not-ready' };
  try {
    const users = await User.find({ role, fcmToken: { $ne: null } }).select('fcmToken').lean();
    const tokens = users.map(u => u.fcmToken).filter(Boolean);
    if (!tokens.length) return { ok: false, sent: 0, failed: 0, reason: 'no-tokens' };
    return await sendPushToMany(tokens, title, body, data);
  } catch (e) { console.warn('⚠️ FCM role push failed:', e.message); return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

async function sendPushToRollNo(rollNo, title, body, data = {}) {
  if (!fcmReady || !rollNo) return { ok: false };
  try {
    const u = await User.findOne({ rollNo: rollNo.toUpperCase() }).select('fcmToken').lean();
    if (!u || !u.fcmToken) return { ok: false, reason: 'no-token' };
    return await sendPushNotification(u.fcmToken, title, body, data);
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ★ NEW: Branch-specific push
async function sendPushToBranch(branch, title, body, data = {}) {
  if (!fcmReady) return { ok: false, sent: 0, failed: 0, reason: 'fcm-not-ready' };
  try {
    const users = await User.find({ role: 'student', branch, fcmToken: { $ne: null } }).select('fcmToken').lean();
    const tokens = users.map(u => u.fcmToken).filter(Boolean);
    if (!tokens.length) return { ok: false, sent: 0, failed: 0, reason: 'no-tokens' };
    return await sendPushToMany(tokens, title, body, data);
  } catch (e) { return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

// ★ NEW: Send to all users (students + faculty + admin)
async function sendPushToAllUsers(title, body, data = {}) {
  if (!fcmReady) return { ok: false, sent: 0, failed: 0, reason: 'fcm-not-ready' };
  try {
    const users = await User.find({ fcmToken: { $ne: null } }).select('fcmToken').lean();
    const tokens = users.map(u => u.fcmToken).filter(Boolean);
    if (!tokens.length) return { ok: false, sent: 0, failed: 0, reason: 'no-tokens' };
    return await sendPushToMany(tokens, title, body, data);
  } catch (e) { return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

// ============================================================
//  AI PROVIDER CONFIG (100% as-is)
// ============================================================
const GROQ_API_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODELS = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const GEMINI_API_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5, process.env.GEMINI_API_KEY_6].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash';
const GEMINI_FALLBACK_MODELS = [process.env.GEMINI_MODEL_2 || 'gemini-3.1-flash-lite', process.env.GEMINI_MODEL_3 || 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-2.0-flash-exp'].filter(Boolean);
const GEMINI_GLOBAL_TIMEOUT_MS = 60000;

const SERVER_START_TIME = Date.now();
let groqKeyIndex = 0;
let geminiKeyIndex = 0;
let _geminiModelsCache = { list: [], fetchedAt: 0 };

function _hashThreadId(threadId, salt = '') { const s = salt + '|' + (threadId || 'default'); let hash = 0; for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0; } return Math.abs(hash); }
function getNextGroqKey(threadId = null, attempt = 0) { if (GROQ_API_KEYS.length === 0) return null; if (!threadId) { const key = GROQ_API_KEYS[groqKeyIndex % GROQ_API_KEYS.length]; groqKeyIndex = (groqKeyIndex + 1) % GROQ_API_KEYS.length; return key; } const start = _hashThreadId(threadId, 'groq') % GROQ_API_KEYS.length; return GROQ_API_KEYS[(start + attempt) % GROQ_API_KEYS.length]; }
function getNextGeminiKey(threadId = null, attempt = 0) { if (GEMINI_API_KEYS.length === 0) return null; if (!threadId) { const key = GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length]; geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length; return key; } const start = _hashThreadId(threadId, 'gemini') % GEMINI_API_KEYS.length; return GEMINI_API_KEYS[(start + attempt) % GEMINI_API_KEYS.length]; }

async function discoverGeminiModels(apiKey) {
  if (!apiKey) return [];
  if (Date.now() - _geminiModelsCache.fetchedAt < 30 * 60 * 1000 && _geminiModelsCache.list.length) return _geminiModelsCache.list;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`List ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, '')).sort((a, b) => {
      const score = (n) => { let s = 0; if (n.includes('flash')) s += 10; if (n.includes('3.8')) s += 6; if (n.includes('3.')) s += 4; if (n.includes('2.5')) s += 3; if (n.includes('2.0')) s += 2; if (n.includes('1.5')) s += 1; if (n.includes('pro')) s -= 3; if (n.includes('lite')) s -= 1; return s; };
      return score(b) - score(a);
    });
    _geminiModelsCache = { list: models, fetchedAt: Date.now() };
    console.log(`🔍 [GEMINI-DISCOVERY] ${models.length} models available. Top: ${models.slice(0, 6).join(', ')}`);
    return models;
  } catch (e) { console.warn('⚠️ Model discovery failed:', e.message); return []; }
}

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 100;
const COLLEGE_CLOSE_HOUR = 15;
const SEMESTER_START = new Date('2026-07-15T00:00:00+05:30');
const SEMESTER_END = new Date('2026-12-31T23:59:59+05:30');

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }
console.log(`🔑 Groq: ${GROQ_API_KEYS.length} | Gemini: ${GEMINI_API_KEYS.length}`);
console.log(`🤖 Primary: Groq(${GROQ_MODEL}) → Gemini(${GEMINI_MODEL})`);

function getISTDateString(dateObj) { const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000)); return istDate.toISOString().split('T')[0]; }
function getISTHour(dateObj) { const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000)); return istDate.getUTCHours(); }
function getISTMinutes(dateObj) { const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000)); return istDate.getUTCHours() * 60 + istDate.getUTCMinutes(); }

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: 'Too many requests.' } });
app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

const registerSchema = z.object({ name: z.string().min(2).max(50), rollNo: z.string().min(3), password: z.string().min(6), deviceId: z.string().optional(), role: z.enum(['student', 'faculty', 'admin']).default('student'), subject: z.string().optional().nullable() });
const loginSchema = z.object({ rollNo: z.string().min(1), password: z.string().min(1), deviceId: z.string().optional() });

function normalizeSubject(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }
const SUBJECT_ALIAS_MAP = {
  'BDA - Big Data Analytics': 'BDA - Big Data Analytics', 'ECO - Economics for Engineers': 'ECO - Economics for Engineers',
  'DAA - Design & Analysis of Algorithm': 'DAA - Design & Analysis of Algorithm', 'FLA - Formal Language & Automata': 'FLA - Formal Language & Automata',
  'HRM - Human Resource Mgmt': 'HRM - Human Resource Mgmt', 'CN - Computer Network': 'CN - Computer Network', 'WT - Web Technology': 'WT - Web Technology',
  'CN LAB - Computer Network Lab': 'CN LAB - Computer Network Lab', 'DAA LAB - Algorithm Lab': 'DAA LAB - Algorithm Lab',
  'WT LAB - Web Technology Lab': 'WT LAB - Web Technology Lab', 'Internet Lab (Ms. Geeta)': 'Internet Lab (Ms. Geeta)',
  'PA - Predictive Analysis': 'PA - Predictive Analysis', 'ML - Machine Learning': 'ML - Machine Learning',
  'PA LAB - Predictive Analysis Lab': 'PA LAB - Predictive Analysis Lab', 'ML LAB - Machine Learning Lab': 'ML LAB - Machine Learning Lab',
  'BDA LAB - Big Data Analytics Lab': 'BDA LAB - Big Data Analytics Lab', 'LIB - Library': 'LIB - Library', 'Sports': 'Sports',
  'BDA': 'BDA - Big Data Analytics', 'ECO': 'ECO - Economics for Engineers', 'DAA': 'DAA - Design & Analysis of Algorithm',
  'FLA': 'FLA - Formal Language & Automata', 'HRM': 'HRM - Human Resource Mgmt', 'CN': 'CN - Computer Network', 'WT': 'WT - Web Technology',
  'CN LAB': 'CN LAB - Computer Network Lab', 'DAA LAB': 'DAA LAB - Algorithm Lab', 'WT LAB': 'WT LAB - Web Technology Lab',
  'Internet': 'Internet Lab (Ms. Geeta)', 'Internet Lab': 'Internet Lab (Ms. Geeta)', 'PA': 'PA - Predictive Analysis',
  'ML': 'ML - Machine Learning', 'PA LAB': 'PA LAB - Predictive Analysis Lab', 'ML LAB': 'ML LAB - Machine Learning Lab',
  'BDA LAB': 'BDA LAB - Big Data Analytics Lab', 'LIB': 'LIB - Library'
};

function mapToCanonical(subject) {
  if (!subject) return '';
  const normalized = normalizeSubject(subject);
  if (SUBJECT_ALIAS_MAP[normalized]) return SUBJECT_ALIAS_MAP[normalized];
  const sortedAliases = Object.keys(SUBJECT_ALIAS_MAP).sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) { if (normalized === alias) return SUBJECT_ALIAS_MAP[alias]; if (normalized.startsWith(alias + ' ')) return SUBJECT_ALIAS_MAP[alias]; }
  for (const alias of sortedAliases) if (normalized.includes(alias)) return SUBJECT_ALIAS_MAP[alias];
  return normalized;
}

function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'english';
  if (/[\u0900-\u097F]/.test(text)) return 'hindi';
  const hinglishWords = new Set(['karo','kar','kro','kr','kya','kyu','kyun','hai','hain','ho','hoga','hogi','hua','hui','mera','meri','mere','mujhe','tumhe','tumhara','tumhari','humko','hum','tum','apna','apni','lagao','lag','laga','dikhao','dikha','dikh','banao','bana','chahiye','chaahiye','mat','nhi','nahi','na','haan','han','yaar','bhai','behen','dost','bata','batao','bataiye','kaise','kaun','kab','kaha','kahan','aaj','kal','parso','subah','shaam','raat','wala','wali','waley','de','dena','dedo','do','diya','bhejo','bhej','save','dalo','daal','jaldi','abhi','thoda','bahut','sab','saare','saara','sari','pura','puri','attend','attendence','hazri','haziri','chhutti','chutti','gaye','gaya','aa','aaoo','aao','padh','padhai','lecture','class','period','samay','time','kam','kaam','zaroori','zarurat','konsa','konsi','kaunsa','kaunsi','kitna','kitni','kitne','bane','banaye','banana','add','hatana','hata','hatao','delete','remove','kholo','khol','mark','present']);
  const words = text.toLowerCase().split(/[\s,.!?;:()\[\]{}"']+/).filter(Boolean);
  const matches = words.filter(w => hinglishWords.has(w)).length;
  if (matches >= 1 && matches / Math.max(words.length, 1) >= 0.12) return 'hinglish';
  return 'english';
}

function languageInstruction(lang) {
  if (lang === 'hindi') return 'User wrote in HINDI (Devanagari). Reply ONLY in HINDI (Devanagari script). Do NOT use English or Latin script.';
  if (lang === 'hinglish') return 'User wrote in HINGLISH (Roman/Latin-script Hindi). Reply ONLY in HINGLISH (Latin letters, Hindi words). Do NOT switch to Devanagari or pure English.';
  return 'User wrote in ENGLISH. Reply ONLY in ENGLISH (Latin script). Do NOT use Hindi words.';
}

// ============================================================
//  TIMETABLE (100% as-is)
// ============================================================
const CSE_TIME_TABLE = {
  Monday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }, { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' }, { subject: 'Sports', faculty: 'Sports Dept' }],
  Tuesday: [{ subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'Internet Lab (Ms. Geeta)', faculty: 'Ms. Geeta' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }, { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'Sports', faculty: 'Sports Dept' }],
  Wednesday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'Sports / Activity', faculty: 'Sports Dept' }, { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' }, { subject: 'CN LAB - Computer Network Lab', faculty: 'Mr. Chhetrapal' }],
  Thursday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' }, { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' }, { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' }, { subject: 'DAA LAB - Algorithm Lab', faculty: 'Ms. Rashmi' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }],
  Friday: [{ subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' }, { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'WT LAB - Web Technology Lab', faculty: 'Mr. Avish Yadav' }, { subject: 'Sports', faculty: 'Sports Dept' }],
  Saturday: [], Sunday: []
};
const AIDS_TIME_TABLE = {
  Monday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'LIB - Library', faculty: 'Library Staff' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }, { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' }, { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' }, { subject: 'Sports', faculty: 'Sports Dept' }],
  Tuesday: [{ subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }, { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' }],
  Wednesday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'Sports / Project', faculty: 'Sports Dept' }, { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' }, { subject: 'PA LAB - Predictive Analysis Lab', faculty: 'Ms. Pooja' }],
  Thursday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' }, { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' }, { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' }, { subject: 'ML LAB - Machine Learning Lab', faculty: 'Mr. Harsh' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }],
  Friday: [{ subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' }, { subject: 'LIB - Library', faculty: 'Library Staff' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'BDA LAB - Big Data Analytics Lab', faculty: 'Ms. Geeta' }, { subject: 'Sports', faculty: 'Sports Dept' }],
  Saturday: [], Sunday: []
};
const CSE_SCHEDULE = {
  1: [{ start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" }, { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" }, { start:"10:50", end:"11:35", subject:"DAA - Design & Analysis of Algorithm", period:"P3", faculty:"Ms. Rashmi" }, { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" }, { start:"13:50", end:"14:35", subject:"CN - Computer Network", period:"P7", faculty:"Mr. Chhetrapal" }, { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }],
  2: [{ start:"09:20", end:"10:05", subject:"WT - Web Technology", period:"P1", faculty:"Mr. Avish Yadav" }, { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" }, { start:"10:50", end:"11:35", subject:"Internet Lab (Ms. Geeta)", period:"P3", faculty:"Ms. Geeta" }, { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" }, { start:"13:50", end:"14:35", subject:"BDA - Big Data Analytics", period:"P7", faculty:"Ms. Geeta" }, { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }],
  3: [{ start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" }, { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" }, { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" }, { start:"11:35", end:"12:20", subject:"Sports / Activity", period:"P4", faculty:"Sports Dept" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"13:50", subject:"WT - Web Technology", period:"P6", faculty:"Mr. Avish Yadav" }, { start:"13:50", end:"15:20", subject:"CN LAB - Computer Network Lab", period:"P7-P8", faculty:"Mr. Chhetrapal" }],
  4: [{ start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" }, { start:"10:05", end:"10:50", subject:"WT - Web Technology", period:"P2", faculty:"Mr. Avish Yadav" }, { start:"10:50", end:"11:35", subject:"CN - Computer Network", period:"P3", faculty:"Mr. Chhetrapal" }, { start:"11:35", end:"12:20", subject:"DAA - Design & Analysis of Algorithm", period:"P4", faculty:"Ms. Rashmi" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"14:35", subject:"DAA LAB - Algorithm Lab", period:"P6-P7", faculty:"Ms. Rashmi" }, { start:"14:35", end:"15:20", subject:"HRM - Human Resource Mgmt", period:"P8", faculty:"Mr. Lokesh" }],
  5: [{ start:"09:20", end:"10:05", subject:"DAA - Design & Analysis of Algorithm", period:"P1", faculty:"Ms. Rashmi" }, { start:"10:05", end:"10:50", subject:"CN - Computer Network", period:"P2", faculty:"Mr. Chhetrapal" }, { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" }, { start:"11:35", end:"12:20", subject:"BDA - Big Data Analytics", period:"P4", faculty:"Ms. Geeta" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"14:35", subject:"WT LAB - Web Technology Lab", period:"P6-P7", faculty:"Mr. Avish Yadav" }, { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }]
};
const AIDS_SCHEDULE = {
  1: [{ start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" }, { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" }, { start:"10:50", end:"11:35", subject:"LIB - Library", period:"P3", faculty:"Library Staff" }, { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" }, { start:"13:50", end:"14:35", subject:"PA - Predictive Analysis", period:"P7", faculty:"Ms. Pooja" }, { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }],
  2: [{ start:"09:20", end:"10:05", subject:"WT - Web Technology", period:"P1", faculty:"Mr. Avish Yadav" }, { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" }, { start:"10:50", end:"11:35", subject:"PA - Predictive Analysis", period:"P3", faculty:"Ms. Pooja" }, { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" }, { start:"13:50", end:"14:35", subject:"BDA - Big Data Analytics", period:"P7", faculty:"Ms. Geeta" }, { start:"14:35", end:"15:20", subject:"ML - Machine Learning", period:"P8", faculty:"Mr. Harsh" }],
  3: [{ start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" }, { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" }, { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" }, { start:"11:35", end:"12:20", subject:"Sports / Project", period:"P4", faculty:"Sports Dept" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"13:50", subject:"WT - Web Technology", period:"P6", faculty:"Mr. Avish Yadav" }, { start:"13:50", end:"15:20", subject:"PA LAB - Predictive Analysis Lab", period:"P7-P8", faculty:"Ms. Pooja" }],
  4: [{ start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" }, { start:"10:05", end:"10:50", subject:"WT - Web Technology", period:"P2", faculty:"Mr. Avish Yadav" }, { start:"10:50", end:"11:35", subject:"ML - Machine Learning", period:"P3", faculty:"Mr. Harsh" }, { start:"11:35", end:"12:20", subject:"PA - Predictive Analysis", period:"P4", faculty:"Ms. Pooja" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"14:35", subject:"ML LAB - Machine Learning Lab", period:"P6-P7", faculty:"Mr. Harsh" }, { start:"14:35", end:"15:20", subject:"HRM - Human Resource Mgmt", period:"P8", faculty:"Mr. Lokesh" }],
  5: [{ start:"09:20", end:"10:05", subject:"ML - Machine Learning", period:"P1", faculty:"Mr. Harsh" }, { start:"10:05", end:"10:50", subject:"LIB - Library", period:"P2", faculty:"Library Staff" }, { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" }, { start:"11:35", end:"12:20", subject:"BDA - Big Data Analytics", period:"P4", faculty:"Ms. Geeta" }, { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" }, { start:"13:05", end:"14:35", subject:"BDA LAB - Big Data Analytics Lab", period:"P6-P7", faculty:"Ms. Geeta" }, { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }]
};

function getTimetableForBranch(branch) { if (branch && branch.toUpperCase() === 'AIDS') return AIDS_TIME_TABLE; return CSE_TIME_TABLE; }
function getScheduleForBranch(branch) { return (branch && branch.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE; }
function getCurrentPeriod(branch = 'CSE') {
  const now = new Date(); const day = now.getDay();
  if (day === 0 || day === 6) return null;
  const schedule = getScheduleForBranch(branch);
  const daySchedule = schedule[day] || [];
  const mins = getISTMinutes(now);
  for (let slot of daySchedule) {
    const s = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);
    const e = parseInt(slot.end.split(':')[0]) * 60 + parseInt(slot.end.split(':')[1]);
    if (mins >= s && mins < e) return slot;
  }
  return null;
}
function getScheduleForDate(dateStr, branch = 'CSE') {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return { isBlocked: true, dayName, schedule: [] };
  const dowIndex = d.getDay();
  const schedule = getScheduleForBranch(branch);
  return { isBlocked: false, dayName, schedule: schedule[dowIndex] || [] };
}
function getTimetableForDate(dateStr, branch = 'CSE') {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return [];
  return getTimetableForBranch(branch)[dayName] || [];
}
function getStrictTimetableResponse(dateStr, branch) {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return `📅 **${dayName} (${dateStr}) — College Closed**\nWeekend, no classes.`;
  const schedule = getScheduleForDate(dateStr, branch);
  const slots = schedule.schedule.filter(s => s.period !== 'LUNCH');
  if (!slots.length) return `📅 ${dayName} (${dateStr}) — No classes scheduled.`;
  let txt = `📅 **${dayName} (${dateStr}) — ${branch} Timetable**\n\n`;
  slots.forEach((sl, i) => { const subj = mapToCanonical(sl.subject); txt += `**${sl.period}** · ${sl.start}–${sl.end}\n  📚 ${subj}\n  👨‍🏫 ${sl.faculty}\n`; if (i < slots.length - 1) txt += `\n`; });
  return txt.trim();
}

async function checkDateStatus(dateStr) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dateObj = new Date(dateStr + 'T00:00:00Z');
  const dayName = days[dateObj.getUTCDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return { isBlocked: true, type: 'WEEKEND', message: `📅 ${dayName}: Closed`, dayName };
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) return { isBlocked: true, type: 'HOLIDAY', message: `🎉 ${holiday.reason}`, dayName, holiday: holiday.reason };
  return { isBlocked: false, dayName };
}

async function getWorkingDays(startDate, endDate) {
  const startStr = typeof startDate === 'string' ? startDate : getISTDateString(startDate);
  const endStr = typeof endDate === 'string' ? endDate : getISTDateString(endDate);
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T23:59:59Z');
  let workingDays = 0;
  const holidays = await Holiday.find({ date: { $gte: startStr, $lte: endStr } });
  const holidaySet = new Set(holidays.map(h => (h.date || '').toString().split('T')[0]));
  let current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const dow = current.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidaySet.has(dateStr)) workingDays++;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return workingDays;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function checkLocation(lat, lng) {
  if (!lat || !lng || lat === 0 || lng === 0) return { isInside: false, distance: "GPS Off" };
  const d = calculateDistance(lat, lng, COLLEGE_LAT, COLLEGE_LNG);
  return { isInside: d <= COLLEGE_RADIUS, distance: d.toFixed(0) };
}

async function checkStudentBlocked(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return { blocked: false };
  if (user.blockUntil && user.blockUntil > new Date()) return { blocked: true, message: `⛔ Blocked until ${user.blockUntil.toLocaleString()}.` };
  if (user.blockUntil && user.blockUntil <= new Date()) { user.failedAttempts = 0; user.blockUntil = null; await user.save(); }
  return { blocked: false };
}
async function incrementFailedAttempts(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return;
  user.failedAttempts = (user.failedAttempts || 0) + 1;
  if (user.failedAttempts >= 5) user.blockUntil = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();
}
async function generateTeacherId(subject) {
  const CODE_MAP = {
    'BDA - Big Data Analytics':'BDA','ECO - Economics for Engineers':'ECO','DAA - Design & Analysis of Algorithm':'DAA','FLA - Formal Language & Automata':'FLA',
    'HRM - Human Resource Mgmt':'HRM','CN - Computer Network':'CN','WT - Web Technology':'WT','Internet Lab (Ms. Geeta)':'INT',
    'CN LAB - Computer Network Lab':'CNL','DAA LAB - Algorithm Lab':'DAAL','WT LAB - Web Technology Lab':'WTL','LIB - Library':'LIB',
    'PA - Predictive Analysis':'PA','ML - Machine Learning':'ML','PA LAB - Predictive Analysis Lab':'PAL','ML LAB - Machine Learning Lab':'MLL',
    'BDA LAB - Big Data Analytics Lab':'BDAL','Sports':'SPT'
  };
  const code = CODE_MAP[subject] || 'TCH';
  const existing = await User.find({ rollNo: { $regex: `^${code}\\d{2}$` }, role: 'faculty' });
  let max = 0;
  existing.forEach(u => { const n = parseInt(u.rollNo.replace(code, '')); if (n > max) max = n; });
  return `${code}${String(max + 1).padStart(2, '0')}`;
}

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => { console.error('❌ MongoDB Error:', err.message); process.exit(1); });

// ============================================================
//  SCHEMAS (existing 100% + new ★)
// ============================================================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, default: null },
  role: { type: String, enum: ['student', 'faculty', 'admin'], default: 'student' },
  boundDeviceId: { type: String, default: null },
  lastAttendanceTime: { type: Date, default: null },
  lastAttendanceLocation: { latitude: Number, longitude: Number },
  failedAttempts: { type: Number, default: 0 },
  blockUntil: { type: Date, default: null },
  email: { type: String, default: null },
  profilePic: { type: String, default: null },
  semester: { type: String, default: '5th' },
  branch: { type: String, default: 'CSE' },
  activeSession: { type: String, default: null },
  facultySubject: { type: String, default: null },
  fcmToken: { type: String, default: null },
  // ★ NEW FIELDS
  dateOfBirth: { type: String, default: null },
  parentEmail: { type: String, default: null },
  parentPhone: { type: String, default: null },
  lastLoginIP: { type: String, default: null },
  lastLoginDevice: { type: String, default: null },
  lastLoginAt: { type: Date, default: null },
  feeStatus: { type: String, enum: ['Paid', 'Pending', 'Partial'], default: 'Paid' },
  feeDueDate: { type: String, default: null },
  feeAmount: { type: Number, default: 0 }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, required: true },
  subject: { type: String, required: true }, date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
  isVerified: { type: Boolean, default: false },
  branch: { type: String, default: 'CSE' },
  markedBy: { type: String, default: null } // ★ NEW
}, { timestamps: true });
attendanceSchema.index({ rollNo: 1, subject: 1, date: 1 }, { unique: true });

const holidaySchema = new mongoose.Schema({ date: { type: String, required: true, unique: true }, reason: { type: String, default: 'Holiday' } }, { timestamps: true });
const noticeSchema = new mongoose.Schema({ title: String, message: String, date: { type: Date, default: Date.now }, postedBy: String }); // ★ postedBy added

const passcodeSchema = new mongoose.Schema({
  passcode: { type: String, required: true },
  type: { type: String, enum: ['full_day', 'single_lecture'], required: true },
  key: { type: String, unique: true, sparse: true },
  expiresAt: { type: Date, required: true },
  published: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: true },
  enabled: { type: Boolean, default: true },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: String, default: null },
  durationMinutes: { type: Number, default: null }
}, { timestamps: true });

const teacherSubjectSchema = new mongoose.Schema({ teacherRollNo: { type: String, required: true }, subject: { type: String, required: true }, assignedBy: { type: String, required: true }, createdAt: { type: Date, default: Date.now } }, { timestamps: true });

const chatSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  threadId: { type: String, required: true, unique: true },
  title: { type: String, default: 'New Chat' },
  messages: [{ role: { type: String, enum: ['user', 'assistant'], required: true }, content: { type: String, required: true }, timestamp: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now }
});

const leaveSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, required: true },
  fromDate: { type: String, required: true }, toDate: { type: String, required: true },
  reason: { type: String, required: true },
  leaveType: { type: String, enum: ['Sick','Personal','Event','Other'], default: 'Personal' },
  status: { type: String, enum: ['Pending','Approved','Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null }, adminNote: { type: String, default: '' },
  branch: { type: String, default: 'CSE' }
}, { timestamps: true });

const attendanceRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, required: true },
  branch: { type: String, default: 'CSE' }, date: { type: String, required: true },
  lectureType: { type: String, enum: ['full_day', 'single_lecture'], required: true },
  subject: { type: String, default: null }, subjects: [{ type: String }],
  period: { type: String, default: null }, reason: { type: String, default: 'Manual attendance request' },
  location: { latitude: Number, longitude: Number }, distanceFromCollege: { type: Number, default: null },
  locationVerified: { type: Boolean, default: false }, isPastDate: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Partially Approved'], default: 'Pending' },
  reviewedBy: { type: String, default: null }, adminNote: { type: String, default: '' },
  reviewHistory: [{ action: { type: String, enum: ['Approved', 'Rejected'] }, by: String, at: { type: Date, default: Date.now }, note: { type: String, default: '' }, reviewedSubjects: [String] }]
}, { timestamps: true });

const accountRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  type: { type: String, enum: ['forgot_password', 'device_reset'], required: true },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Used'], default: 'Pending' },
  reviewedBy: { type: String, default: null }, adminNote: { type: String, default: '' }
}, { timestamps: true });

const registrationRequestSchema = new mongoose.Schema({
  name: { type: String, required: true }, rollNo: { type: String, required: true },
  password: { type: String, required: true }, deviceId: { type: String, default: null },
  branch: { type: String, default: 'CSE' }, role: { type: String, enum: ['student'], default: 'student' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null }, adminNote: { type: String, default: '' },
  approvedUserRollNo: { type: String, default: null }
}, { timestamps: true });
registrationRequestSchema.index({ rollNo: 1, status: 1 });

const pendingActionSchema = new mongoose.Schema({
  rollNo: { type: String, required: true, index: true }, type: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} }, lang: { type: String, default: 'english' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });
pendingActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ★★★ NEW SCHEMAS (Advanced Features) ★★★
const feeSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, amount: { type: Number, required: true },
  dueDate: { type: String, required: true }, status: { type: String, enum: ['Paid', 'Pending', 'Partial', 'Overdue'], default: 'Pending' },
  paidAmount: { type: Number, default: 0 }, paidDate: { type: String, default: null },
  description: { type: String, default: 'Semester Fee' }, academicYear: { type: String, default: '2026-27' },
  remindersSent: { type: [String], default: [] }
}, { timestamps: true });
feeSchema.index({ rollNo: 1, academicYear: 1 });

const assignmentSchema = new mongoose.Schema({
  subject: { type: String, required: true }, branch: { type: String, default: 'CSE' },
  title: { type: String, required: true }, description: { type: String, default: '' },
  dueDate: { type: String, required: true }, postedBy: { type: String, required: true },
  facultyName: { type: String, default: '' }, attachmentUrl: { type: String, default: null },
  remindersSent: { type: [String], default: [] }
}, { timestamps: true });

const examSchema = new mongoose.Schema({
  subject: { type: String, required: true }, branch: { type: String, default: 'CSE' },
  examType: { type: String, enum: ['Mid-Term', 'End-Term', 'Quiz', 'Practical', 'Viva'], default: 'Mid-Term' },
  examDate: { type: String, required: true }, startTime: { type: String, default: '10:00' },
  endTime: { type: String, default: '12:00' }, venue: { type: String, default: 'TBD' },
  postedBy: { type: String, required: true }, remindersSent: { type: [String], default: [] }
}, { timestamps: true });

const libraryBookSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, default: '' },
  bookTitle: { type: String, required: true }, bookAuthor: { type: String, default: '' },
  issueDate: { type: String, required: true }, dueDate: { type: String, required: true },
  returnDate: { type: String, default: null }, status: { type: String, enum: ['Issued', 'Returned', 'Overdue'], default: 'Issued' },
  fineAmount: { type: Number, default: 0 }, remindersSent: { type: [String], default: [] }
}, { timestamps: true });

const resultSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, default: '' },
  subject: { type: String, required: true }, examType: { type: String, default: 'Mid-Term' },
  marksObtained: { type: Number, required: true }, totalMarks: { type: Number, default: 100 },
  grade: { type: String, default: '' }, publishedBy: { type: String, required: true },
  publishedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const announcementSchema = new mongoose.Schema({
  subject: { type: String, required: true }, branch: { type: String, default: 'CSE' },
  facultyRollNo: { type: String, required: true }, facultyName: { type: String, default: '' },
  message: { type: String, required: true }
}, { timestamps: true });

const emergencyAlertSchema = new mongoose.Schema({
  title: { type: String, required: true }, message: { type: String, required: true },
  postedBy: { type: String, required: true }, active: { type: Boolean, default: true }
}, { timestamps: true });

// Model Registration
const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const Passcode = mongoose.model('Passcode', passcodeSchema);
const TeacherSubject = mongoose.model('TeacherSubject', teacherSubjectSchema);
const Chat = mongoose.model('Chat', chatSchema);
const Leave = mongoose.model('Leave', leaveSchema);
const AttendanceRequest = mongoose.model('AttendanceRequest', attendanceRequestSchema);
const AccountRequest = mongoose.model('AccountRequest', accountRequestSchema);
const RegistrationRequest = mongoose.model('RegistrationRequest', registrationRequestSchema);
const PendingAction = mongoose.model('PendingAction', pendingActionSchema);
// ★ NEW MODELS
const Fee = mongoose.model('Fee', feeSchema);
const Assignment = mongoose.model('Assignment', assignmentSchema);
const Exam = mongoose.model('Exam', examSchema);
const LibraryBook = mongoose.model('LibraryBook', libraryBookSchema);
const Result = mongoose.model('Result', resultSchema);
const Announcement = mongoose.model('Announcement', announcementSchema);
const EmergencyAlert = mongoose.model('EmergencyAlert', emergencyAlertSchema);

Attendance.createIndexes().catch(err => console.error('Index error:', err));


// ============================================================
//  STUDENT SUMMARY (existing — 100% as-is)
// ============================================================
async function getStudentSummary(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return null;
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => (h.date || '').toString().split('T')[0]));
    const today = new Date();
    const todayStr = getISTDateString(today);
    const semesterStart = new Date('2026-07-15T00:00:00+05:30');
    let current = new Date(semesterStart);
    let totalConducted = 0;
    const subjectStats = {};
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayAcad = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subs = timetable[dayName] || [];
      const acad = subs.filter(e => !e.subject.includes("LIB") && !e.subject.includes("Library") && !e.subject.includes("Sports"));
      dayAcad[dayName] = acad.map(e => mapToCanonical(e.subject));
    }
    while (current <= today) {
      const ds = getISTDateString(current);
      if (ds > todayStr) { current.setDate(current.getDate() + 1); continue; }
      const dow = current.getDay();
      const isWknd = (dow === 0 || dow === 6);
      const isHoliday = holidaySet.has(ds);
      if (!isWknd && !isHoliday) {
        const dayName = dayNameMap[dow];
        const acad = dayAcad[dayName] || [];
        totalConducted += acad.length;
        acad.forEach(sub => { if (!subjectStats[sub]) subjectStats[sub] = { total: 0, present: 0 }; subjectStats[sub].total++; });
      }
      current.setDate(current.getDate() + 1);
    }
    const subPresent = {};
    const presentDaysSet = new Set();
    allRecords.forEach(rec => {
      const sub = mapToCanonical(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        subPresent[sub] = (subPresent[sub] || 0) + 1;
        const dateKey = (rec.date || '').toString().split('T')[0].trim();
        if (dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) presentDaysSet.add(dateKey);
      }
    });
    Object.keys(subPresent).forEach(sub => { if (subjectStats[sub]) subjectStats[sub].present = subPresent[sub]; });
    let totalAttended = 0;
    Object.values(subPresent).forEach(v => totalAttended += v);
    const pct = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : 0;
    const subjectStatsFinal = {};
    for (let [sub, stats] of Object.entries(subjectStats)) {
      subjectStatsFinal[sub] = { present: stats.present || 0, total: stats.total || 0, percentage: stats.total > 0 ? Math.round(((stats.present || 0) / stats.total) * 100) : 0 };
    }
    const daysPresent = presentDaysSet.size;
    const workingDaysSoFar = await getWorkingDays(semesterStart, today);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStart, SEMESTER_END);
    return { totalAcademicLectures: totalAttended, totalConductedLectures: totalConducted, attendancePercentage: pct, subjectStats: subjectStatsFinal, daysPresent, workingDaysSoFar, totalWorkingDaysSemester };
  } catch (e) { console.error('getStudentSummary error:', e); return null; }
}

async function getBunkAdvisor(rollNo) {
  const summary = await getStudentSummary(rollNo);
  if (!summary) return null;
  const { totalAcademicLectures: attended, totalConductedLectures: total, attendancePercentage: pct } = summary;
  const target = 0.75;
  const canBunkLectures = total > 0 ? Math.max(0, Math.floor((attended - target * total) / target)) : 0;
  const lecturesNeeded = pct >= 75 ? 0 : Math.max(0, Math.ceil((target * total - attended) / (1 - target)));
  return {
    totalAttended: attended, totalConducted: total, percentage: pct,
    canBunkLectures, lecturesNeeded,
    status: pct >= 75 ? 'SAFE' : 'DANGER',
    message: pct >= 75
      ? `✅ You are at ${pct}% (${attended}/${total}). You can skip about ${canBunkLectures} lecture(s) and still stay at ≥75%.`
      : `⚠️ You are at ${pct}% (${attended}/${total}) — BELOW 75%. You need to attend ${lecturesNeeded} more lecture(s) to reach 75%.`
  };
}

// ============================================================
//  ★ NEW: MILESTONE CHECKER (for attendance celebration notifications)
// ============================================================
async function checkAttendanceMilestone(rollNo) {
  try {
    const summary = await getStudentSummary(rollNo);
    if (!summary) return;
    const pct = summary.attendancePercentage;
    const todayStr = getISTDateString(new Date());
    if (pct >= 95) {
      sendPushToRollNo(rollNo, '🎉 Outstanding Attendance!', `Congrats! You crossed 95% (${summary.totalAcademicLectures}/${summary.totalConductedLectures}). Keep it up!`, { type: 'milestone', pct: '95' }).catch(() => {});
    } else if (pct >= 90) {
      sendPushToRollNo(rollNo, '🎉 Great Attendance!', `Excellent! You crossed 90% (${summary.totalAcademicLectures}/${summary.totalConductedLectures}).`, { type: 'milestone', pct: '90' }).catch(() => {});
    }
  } catch (e) { console.warn('Milestone check:', e.message); }
}

// ============================================================
//  THINKING STEPS (existing — 100% as-is)
// ============================================================
function buildThinkingSteps(ctx) {
  const { userMessage = '', userRole = 'student', fastIntent = null, aiIntent = null, execResult = null, provider = null, latencyMs = 0, flags = {} } = ctx;
  const steps = [];
  const msg = String(userMessage || '').slice(0, 100);
  steps.push(`📩 Received: "${msg}"`);
  steps.push(`👤 Role: ${userRole}`);
  if (fastIntent) steps.push(`⚡ Regex fast-match: action="${fastIntent.action}"`);
  else if (aiIntent) {
    steps.push(`🧠 AI parsed intent: action="${aiIntent.action || 'reply'}"`);
    if (aiIntent.explanation) steps.push(`   ↳ ${aiIntent.explanation}`);
    if (aiIntent.requiresConfirmation) steps.push(`   ↳ ⚠️ Needs confirmation`);
  } else steps.push(`💬 Casual chat mode`);
  if (execResult) {
    if (execResult.isReply) steps.push(`✅ Reply composed directly`);
    else if (execResult.error) steps.push(`❌ Execution failed: ${execResult.error}`);
    else if (execResult.needsLiveMarking) steps.push(`📍 Live-marking flow started`);
    else if (execResult.result) steps.push(`✅ DB operation completed`);
  }
  if (flags.passcodeVerified) steps.push(`🔐 Passcode verified`);
  if (flags.locationVerified) steps.push(`📍 Location verified (within campus)`);
  if (flags.attendanceMarked) steps.push(`✅ Attendance marked in DB`);
  if (flags.languageDetected) steps.push(`🌐 Detected language: ${flags.languageDetected}`);
  if (provider) steps.push(`🤖 AI provider: ${provider}`);
  if (latencyMs > 0) steps.push(`⏱ Completed in ${(latencyMs / 1000).toFixed(2)}s`);
  return steps;
}

// ============================================================
//  AI CALLS (existing — 100% as-is)
// ============================================================
async function callGroqOnce({ prompt, systemPrompt = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 45000, model = null, apiKey = null, threadId = null, attempt = 0, forceJson = false }) {
  const useKey = apiKey || getNextGroqKey(threadId, attempt);
  if (!useKey) throw new Error('No Groq API key');
  const useModel = model || GROQ_MODEL;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (history && Array.isArray(history)) {
    const recent = history.slice(-6);
    for (const m of recent) { if (!m || !m.content) continue; messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }); }
  }
  messages.push({ role: 'user', content: prompt });
  const body = { model: useModel, messages, max_tokens: maxTokens, temperature, top_p: 0.95 };
  if (forceJson) body.response_format = { type: 'json_object' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(GROQ_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${useKey}` }, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) { const errText = await response.text(); throw new Error(`Groq ${response.status}: ${errText.substring(0, 300)}`); }
    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty Groq response');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text;
  } catch (err) { clearTimeout(timeout); throw err; }
}

async function callGroq(args) {
  const modelsToTry = [args.model || GROQ_MODEL, ...GROQ_FALLBACK_MODELS];
  if (GROQ_API_KEYS.length === 0) throw new Error('No Groq API key');
  let lastError = null;
  for (const model of modelsToTry) {
    const apiKey = getNextGroqKey(args.threadId || null, 0);
    if (!apiKey) break;
    try {
      console.log(`🚀 [GROQ] thread=${args.threadId || '-'} model=${model}${args.forceJson ? ' (json)' : ''}`);
      return await callGroqOnce({ ...args, model, apiKey, attempt: 0 });
    } catch (err) { lastError = err; console.warn(`⚠️ [GROQ] ${model}: ${err.message.substring(0, 100)}`); }
  }
  throw lastError || new Error('Groq failed');
}

function parseGeminiError(err) {
  const msg = err.message || String(err);
  if (msg.includes('429') || msg.toLowerCase().includes('quota')) return { code: 429, type: 'RATE_LIMIT' };
  if (msg.includes('503') || msg.toLowerCase().includes('high demand')) return { code: 503, type: 'OVERLOADED' };
  if (msg.includes('504') || msg.toLowerCase().includes('deadline')) return { code: 504, type: 'TIMEOUT' };
  if (msg.includes('404') || msg.toLowerCase().includes('not found')) return { code: 404, type: 'MODEL_NOT_FOUND' };
  if (msg.includes('400') || msg.toLowerCase().includes('invalid')) return { code: 400, type: 'BAD_REQUEST' };
  return { code: 500, type: 'UNKNOWN' };
}

async function callGeminiOnce({ prompt, systemPrompt = null, fileBase64 = null, mimeType = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 60000, model = null, apiKey = null, threadId = null, attempt = 0 }) {
  const useKey = apiKey || getNextGeminiKey(threadId, attempt);
  if (!useKey) throw new Error('No Gemini API key');
  const useModel = model || GEMINI_MODEL;
  const contents = [];
  if (history && Array.isArray(history)) {
    const recent = history.slice(-6);
    for (const m of recent) { if (!m || !m.content) continue; contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); }
  }
  const userParts = [{ text: prompt }];
  if (fileBase64 && mimeType) userParts.push({ inline_data: { mime_type: mimeType, data: fileBase64 } });
  contents.push({ role: 'user', parts: userParts });
  const payload = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.95 } };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${useKey}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) { const errText = await response.text(); throw new Error(`Gemini ${response.status}: ${errText.substring(0, 300)}`); }
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim();
    if (!text) throw new Error('Empty Gemini response');
    return text;
  } catch (err) { clearTimeout(timeout); throw err; }
}

async function callGemini(args) {
  if (GEMINI_API_KEYS.length === 0) throw new Error('No Gemini API key');
  const preferred = [args.model || GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean);
  const startTime = Date.now();
  let lastError = null;
  for (const model of preferred) {
    for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
      if (Date.now() - startTime > GEMINI_GLOBAL_TIMEOUT_MS) throw new Error('Gemini timeout');
      const apiKey = getNextGeminiKey(args.threadId || null, i);
      if (!apiKey) break;
      try { console.log(`🤖 [GEMINI] thread=${args.threadId || '-'} model=${model}`); return await callGeminiOnce({ ...args, model, apiKey, attempt: i }); }
      catch (err) { lastError = err; const parsed = parseGeminiError(err); console.warn(`⚠️ [GEMINI ${parsed.code}] ${model}: ${err.message.substring(0, 100)}`); if (parsed.type === 'MODEL_NOT_FOUND') break; }
    }
  }
  console.log(`🔍 [GEMINI] Auto-discovering...`);
  const discovered = await discoverGeminiModels(GEMINI_API_KEYS[0]);
  const remaining = discovered.filter(m => !preferred.includes(m));
  for (const model of remaining.slice(0, 3)) {
    if (Date.now() - startTime > GEMINI_GLOBAL_TIMEOUT_MS) break;
    try { return await callGeminiOnce({ ...args, model, apiKey: GEMINI_API_KEYS[0], attempt: 0 }); }
    catch (err) { lastError = err; }
  }
  throw lastError || new Error('All Gemini models failed.');
}

async function callAI(args) {
  const TOTAL_TIMEOUT = 90000;
  const startTime = Date.now();
  let groqError = null;
  if (GROQ_API_KEYS.length > 0) {
    try {
      const reply = await callGroq({ ...args, timeoutMs: Math.min(45000, TOTAL_TIMEOUT - (Date.now() - startTime)) });
      return { reply, provider: 'groq', model: GROQ_MODEL };
    } catch (err) { groqError = err; }
  }
  const remainingTime = TOTAL_TIMEOUT - (Date.now() - startTime);
  if (remainingTime <= 0) throw new Error('AI too slow.');
  try {
    const reply = await callGemini({ ...args, globalTimeoutMs: remainingTime });
    return { reply, provider: 'gemini', model: GEMINI_MODEL };
  } catch (geminiError) {
    throw new Error(`Both AI providers failed. Groq: ${groqError?.message.substring(0,80)} | Gemini: ${geminiError.message.substring(0,80)}`);
  }
}

// ============================================================
//  PDF HELPER (existing — 100% as-is)
// ============================================================
function generatePDFBuffer({ title, subtitle, sections = [], footer = null }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.fillColor('#1e40af').fontSize(22).font('Helvetica-Bold').text('BM Group of Institutions', { align: 'center' });
      doc.moveDown(0.2);
      doc.fillColor('#333').fontSize(16).font('Helvetica-Bold').text(title || 'Report', { align: 'center' });
      if (subtitle) doc.fontSize(11).font('Helvetica').fillColor('#666').text(subtitle, { align: 'center' });
      doc.moveDown(0.5);
      doc.strokeColor('#1e40af').lineWidth(2).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(1);
      sections.forEach(sec => {
        if (sec.heading) { doc.fillColor('#1e40af').fontSize(14).font('Helvetica-Bold').text(sec.heading); doc.moveDown(0.3); }
        if (sec.text) { doc.fillColor('#000').fontSize(11).font('Helvetica').text(sec.text, { lineGap: 3 }); doc.moveDown(0.6); }
        if (sec.bullets && Array.isArray(sec.bullets)) { sec.bullets.forEach(b => doc.fillColor('#000').fontSize(11).font('Helvetica').text('•  ' + b, { indent: 10, lineGap: 3 })); doc.moveDown(0.6); }
        if (sec.table && Array.isArray(sec.table.rows)) {
          const { headers = [], rows = [] } = sec.table;
          if (headers.length) { doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e40af').text(headers.join('   |   ')); doc.font('Helvetica').fillColor('#000'); doc.moveDown(0.3); }
          rows.forEach(r => doc.fontSize(10).text(r.join('   |   ')));
          doc.moveDown(0.6);
        }
      });
      doc.moveDown(1);
      doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#666').text(footer || `Generated by BM Bot on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, { align: 'center' });
      doc.end();
    } catch (err) { reject(err); }
  });
}

// ============================================================
//  ROUTES — HEALTH & FCM (existing — 100% as-is)
// ============================================================
app.get('/', (req, res) => res.send('BM Group ERP Active!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: { primary: { provider: 'groq', model: GROQ_MODEL, keys: GROQ_API_KEYS.length }, fallback: { provider: 'gemini', model: GEMINI_MODEL, keys: GEMINI_API_KEYS.length, discovered: _geminiModelsCache.list.length } },
  fcm: { ready: fcmReady, projectId: process.env.FIREBASE_PROJECT_ID || null },
  timestamp: new Date().toISOString()
}));

app.get('/api/health/push', async (req, res) => {
  try {
    let tokenCount = 0;
    try { tokenCount = await User.countDocuments({ fcmToken: { $ne: null } }); } catch (e) {}
    res.json({ fcmReady, projectId: process.env.FIREBASE_PROJECT_ID || null, hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY, hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL, usersWithTokens: tokenCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/save-fcm-token', async (req, res) => {
  try {
    const { rollNo, fcmToken } = req.body || {};
    if (!rollNo || !fcmToken) return res.status(400).json({ error: 'rollNo and fcmToken required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.fcmToken = fcmToken;
    await user.save();
    console.log(`📱 [FCM-SAVE] ${cr} token saved (${fcmToken.substring(0, 20)}...)`);
    res.json({ message: 'FCM token saved', fcmReady });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/remove-fcm-token', async (req, res) => {
  try {
    const { rollNo } = req.body || {};
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cr = rollNo.trim().toUpperCase();
    await User.updateOne({ rollNo: cr }, { $set: { fcmToken: null } });
    res.json({ message: 'FCM token removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/test-push', async (req, res) => {
  try {
    const { rollNo } = req.body || {};
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    if (!fcmReady) return res.status(503).json({ error: 'FCM not ready — check env vars' });
    const cr = rollNo.trim().toUpperCase();
    const result = await sendPushToRollNo(cr, '🧪 Test Notification', 'This is a test push from BM Group ERP!', { type: 'test' });
    res.json({ message: 'Test sent', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: FEE MANAGEMENT ENDPOINTS ★★★
// ============================================================
app.post('/api/admin/fee/add', async (req, res) => {
  try {
    const { requesterRollNo, rollNo, amount, dueDate, description, academicYear } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!rollNo || !amount || !dueDate) return res.status(400).json({ error: 'rollNo, amount, dueDate required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Student not found' });
    const fee = await Fee.create({ rollNo: cr, amount: parseInt(amount), dueDate, description: description || 'Semester Fee', academicYear: academicYear || '2026-27' });
    user.feeStatus = 'Pending'; user.feeDueDate = dueDate; user.feeAmount = parseInt(amount);
    await user.save();
    res.status(201).json({ message: `Fee added for ${cr}`, fee });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fee/bulk-add', async (req, res) => {
  try {
    const { requesterRollNo, amount, dueDate, description, branch, academicYear } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const q = { role: 'student' };
    if (branch && branch !== 'ALL') q.branch = branch;
    const students = await User.find(q).select('rollNo');
    let added = 0;
    for (const s of students) {
      const existing = await Fee.findOne({ rollNo: s.rollNo, academicYear: academicYear || '2026-27', dueDate });
      if (existing) continue;
      await Fee.create({ rollNo: s.rollNo, amount: parseInt(amount), dueDate, description: description || 'Semester Fee', academicYear: academicYear || '2026-27' });
      await User.updateOne({ rollNo: s.rollNo }, { feeStatus: 'Pending', feeDueDate: dueDate, feeAmount: parseInt(amount) });
      added++;
    }
    res.json({ message: `Fee added for ${added} student(s)`, totalStudents: students.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/fees/:rollNo', async (req, res) => {
  try {
    const fees = await Fee.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ dueDate: -1 });
    res.json(fees);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/fees/:requesterRollNo', async (req, res) => {
  try {
    const adminUser = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const status = req.query.status;
    const q = status ? { status } : {};
    const fees = await Fee.find(q).sort({ dueDate: 1 }).limit(500).lean();
    res.json({ count: fees.length, fees });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fee/mark-paid/:feeId', async (req, res) => {
  try {
    const { requesterRollNo, paidAmount } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const fee = await Fee.findById(req.params.feeId);
    if (!fee) return res.status(404).json({ error: 'Fee not found' });
    fee.paidAmount = paidAmount ? parseInt(paidAmount) : fee.amount;
    fee.status = fee.paidAmount >= fee.amount ? 'Paid' : 'Partial';
    fee.paidDate = getISTDateString(new Date());
    await fee.save();
    if (fee.status === 'Paid') await User.updateOne({ rollNo: fee.rollNo }, { feeStatus: 'Paid' });
    res.json({ message: 'Fee marked', fee });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: ASSIGNMENT ENDPOINTS ★★★
// ============================================================
app.post('/api/faculty/assignment/create', async (req, res) => {
  try {
    const { requesterRollNo, subject, branch, title, description, dueDate } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || (user.role !== 'faculty' && user.role !== 'admin')) return res.status(403).json({ error: 'Faculty/Admin only' });
    if (!subject || !title || !dueDate) return res.status(400).json({ error: 'subject, title, dueDate required' });
    const assignment = await Assignment.create({ subject: mapToCanonical(subject), branch: branch || 'CSE', title, description: description || '', dueDate, postedBy: user.rollNo, facultyName: user.name });
    sendPushToBranch(branch || 'CSE', '📝 New Assignment', `${title} — ${mapToCanonical(subject)} — Due ${dueDate}`, { type: 'new_assignment', assignmentId: assignment._id.toString() }).catch(() => {});
    res.status(201).json({ message: 'Assignment posted', assignment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/assignments/:branch', async (req, res) => {
  try {
    const assignments = await Assignment.find({ branch: req.params.branch.toUpperCase() }).sort({ dueDate: 1 });
    res.json(assignments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/faculty/assignment/:id', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || (user.role !== 'faculty' && user.role !== 'admin')) return res.status(403).json({ error: 'Faculty/Admin only' });
    const a = await Assignment.findByIdAndDelete(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: EXAM ENDPOINTS ★★★
// ============================================================
app.post('/api/admin/exam/create', async (req, res) => {
  try {
    const { requesterRollNo, subject, branch, examType, examDate, startTime, endTime, venue } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!subject || !examDate) return res.status(400).json({ error: 'subject, examDate required' });
    const exam = await Exam.create({ subject: mapToCanonical(subject), branch: branch || 'CSE', examType: examType || 'Mid-Term', examDate, startTime: startTime || '10:00', endTime: endTime || '12:00', venue: venue || 'TBD', postedBy: user.rollNo });
    sendPushToBranch(branch || 'CSE', '📝 New Exam Scheduled', `${mapToCanonical(subject)} — ${examDate} at ${startTime || '10:00'} — ${venue || 'TBD'}`, { type: 'new_exam', examId: exam._id.toString() }).catch(() => {});
    res.status(201).json({ message: 'Exam scheduled', exam });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/exams/:branch', async (req, res) => {
  try { res.json(await Exam.find({ branch: req.params.branch.toUpperCase() }).sort({ examDate: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/exam/:id', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const e = await Exam.findByIdAndDelete(req.params.id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: LIBRARY ENDPOINTS ★★★
// ============================================================
app.post('/api/admin/library/issue', async (req, res) => {
  try {
    const { requesterRollNo, rollNo, bookTitle, bookAuthor, dueDate } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!rollNo || !bookTitle || !dueDate) return res.status(400).json({ error: 'rollNo, bookTitle, dueDate required' });
    const cr = rollNo.trim().toUpperCase();
    const student = await User.findOne({ rollNo: cr });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const book = await LibraryBook.create({ rollNo: cr, studentName: student.name, bookTitle, bookAuthor: bookAuthor || '', issueDate: getISTDateString(new Date()), dueDate });
    sendPushToRollNo(cr, '📚 Book Issued', `"${bookTitle}" issued. Due date: ${dueDate}`, { type: 'book_issued' }).catch(() => {});
    res.status(201).json({ message: 'Book issued', book });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/library/:rollNo', async (req, res) => {
  try { res.json(await LibraryBook.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ dueDate: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/library/all/:requesterRollNo', async (req, res) => {
  try {
    const adminUser = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const books = await LibraryBook.find({}).sort({ dueDate: 1 }).limit(500);
    res.json(books);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/library/return/:bookId', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const book = await LibraryBook.findById(req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    book.status = 'Returned'; book.returnDate = getISTDateString(new Date());
    await book.save();
    res.json({ message: 'Book returned', book });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: RESULT ENDPOINTS ★★★
// ============================================================
app.post('/api/admin/result/publish', async (req, res) => {
  try {
    const { requesterRollNo, rollNo, subject, examType, marksObtained, totalMarks, grade } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!rollNo || !subject || marksObtained === undefined) return res.status(400).json({ error: 'rollNo, subject, marksObtained required' });
    const cr = rollNo.trim().toUpperCase();
    const student = await User.findOne({ rollNo: cr });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const result = await Result.create({ rollNo: cr, studentName: student.name, subject: mapToCanonical(subject), examType: examType || 'Mid-Term', marksObtained: parseInt(marksObtained), totalMarks: parseInt(totalMarks) || 100, grade: grade || '', publishedBy: adminUser.rollNo });
    sendPushToRollNo(cr, '📊 Result Published', `${result.subject} — ${result.marksObtained}/${result.totalMarks}. Check now!`, { type: 'result_published', resultId: result._id.toString() }).catch(() => {});
    res.status(201).json({ message: 'Result published', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/results/:rollNo', async (req, res) => {
  try { res.json(await Result.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ publishedAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: EMERGENCY ALERT ★★★
// ============================================================
app.post('/api/admin/emergency-alert', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    await EmergencyAlert.create({ title, message, postedBy: adminUser.rollNo });
    const result = await sendPushToAllUsers(`🚨 ${title}`, message, { type: 'emergency' });
    res.status(201).json({ message: 'Emergency alert sent', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ NEW: FACULTY ANNOUNCEMENT TO CLASS ★★★
// ============================================================
app.post('/api/faculty/announcement', async (req, res) => {
  try {
    const { requesterRollNo, subject, branch, message } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || (user.role !== 'faculty' && user.role !== 'admin')) return res.status(403).json({ error: 'Faculty/Admin only' });
    if (!subject || !message) return res.status(400).json({ error: 'subject and message required' });
    await Announcement.create({ subject: mapToCanonical(subject), branch: branch || user.branch || 'CSE', facultyRollNo: user.rollNo, facultyName: user.name, message });
    sendPushToBranch(branch || user.branch || 'CSE', `👨‍🏫 ${user.name}`, message, { type: 'faculty_announcement', subject: mapToCanonical(subject) }).catch(() => {});
    res.status(201).json({ message: 'Announcement sent' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ============================================================
//  AUTH ROUTES (existing — 100% as-is)
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    let { name, rollNo, password, deviceId, role, subject } = parsed.data;
    let cleanRoll = rollNo.trim().toUpperCase();
    if (role === 'student' && !/^24(CSE|AIDS)\d{2}$/.test(cleanRoll)) return res.status(400).json({ error: 'Invalid Roll format! Use 24CSE01 or 24AIDS01.' });
    if (role === 'faculty' && (!cleanRoll || cleanRoll === 'AUTO' || cleanRoll === '')) {
      if (!subject) return res.status(400).json({ error: 'Subject required for faculty.' });
      cleanRoll = await generateTeacherId(subject);
    }
    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'ID already registered!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    let branch = 'CSE';
    if (role === 'student' && cleanRoll.includes('AIDS')) branch = 'AIDS';
    const boundDeviceId = (role === 'student') ? (deviceId || null) : null;
    const newUser = new User({ name, rollNo: cleanRoll, password: hashedPassword, role, boundDeviceId, branch, facultySubject: (role === 'faculty') ? subject : null });
    await newUser.save();
    if (role === 'faculty' && subject) await TeacherSubject.create({ teacherRollNo: cleanRoll, subject: mapToCanonical(subject), assignedBy: cleanRoll });
    res.status(201).json({ message: `${role} ${name} Registered!`, rollNo: cleanRoll });
  } catch (err) { console.error('Register error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/register-request', async (req, res) => {
  try {
    const { name, rollNo, password, deviceId } = req.body || {};
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name required (min 2 chars).' });
    if (!rollNo) return res.status(400).json({ error: 'Roll number required.' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars.' });
    const cleanRoll = rollNo.trim().toUpperCase();
    if (!/^24(CSE|AIDS)\d{2}$/.test(cleanRoll)) return res.status(400).json({ error: 'Invalid Roll format.' });
    if (await User.findOne({ rollNo: cleanRoll })) return res.status(400).json({ error: 'Roll already registered. Sign in.' });
    if (await RegistrationRequest.findOne({ rollNo: cleanRoll, status: 'Pending' })) return res.status(400).json({ error: 'Pending approval already.' });
    const hashed = await bcrypt.hash(password, 10);
    const branch = cleanRoll.includes('AIDS') ? 'AIDS' : 'CSE';
    const newReq = await RegistrationRequest.create({ name: name.trim(), rollNo: cleanRoll, password: hashed, deviceId: deviceId || null, branch });
    sendPushToRole('admin', '📝 New Registration Request', `${newReq.name} (${newReq.rollNo}) — ${newReq.branch}`, { type: 'registration', rollNo: newReq.rollNo }).catch(() => {});
    res.status(201).json({ message: '✅ Request submitted. Wait for admin approval.', request: { _id: newReq._id, name: newReq.name, rollNo: newReq.rollNo, branch: newReq.branch, status: newReq.status, createdAt: newReq.createdAt } });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/register-request/check/:rollNo', async (req, res) => {
  try {
    const cr = (req.params.rollNo || '').trim().toUpperCase();
    if (!cr) return res.status(400).json({ error: 'rollNo required' });
    const requests = await RegistrationRequest.find({ rollNo: cr }).sort({ createdAt: -1 }).limit(5);
    res.json({ count: requests.length, requests: requests.map(r => ({ _id: r._id, rollNo: r.rollNo, name: r.name, branch: r.branch, status: r.status, adminNote: r.adminNote, createdAt: r.createdAt, reviewedAt: r.updatedAt })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/registration-requests/:requesterRollNo', async (req, res) => {
  try {
    const rn = (req.params.requesterRollNo || '').trim().toUpperCase();
    const adminUser = await User.findOne({ rollNo: rn });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const status = req.query.status || 'Pending';
    const filter = status === 'ALL' ? {} : { status };
    const requests = await RegistrationRequest.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ count: requests.length, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/registration-requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note } = req.body || {};
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const r = await RegistrationRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'Pending') return res.status(400).json({ error: `Already ${r.status}` });
    r.status = action; r.reviewedBy = adminUser.rollNo; r.adminNote = note || '';
    if (action === 'Approved') {
      const dup = await User.findOne({ rollNo: r.rollNo });
      if (dup) { r.status = 'Rejected'; r.adminNote = (r.adminNote ? r.adminNote + ' · ' : '') + 'User exists'; await r.save(); return res.status(400).json({ error: 'User exists.' }); }
      const newUser = await User.create({ name: r.name, rollNo: r.rollNo, password: r.password, role: 'student', branch: r.branch, boundDeviceId: r.deviceId || null });
      r.approvedUserRollNo = newUser.rollNo;
    }
    await r.save();
    res.json({ message: `Registration ${action}`, request: { _id: r._id, status: r.status, rollNo: r.rollNo, approvedUserRollNo: r.approvedUserRollNo } });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clear-registrations', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = await RegistrationRequest.deleteMany({});
    res.json({ message: `Deleted ${r.deletedCount} registration request(s).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const { rollNo, password, deviceId } = parsed.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) {
      const pendingReq = await RegistrationRequest.findOne({ rollNo: cleanRoll, status: 'Pending' });
      if (pendingReq) return res.status(403).json({ error: '⏳ Registration pending admin approval.' });
      const rejReq = await RegistrationRequest.findOne({ rollNo: cleanRoll, status: 'Rejected' }).sort({ updatedAt: -1 });
      if (rejReq) return res.status(403).json({ error: `❌ Registration rejected.${rejReq.adminNote ? ' Note: ' + rejReq.adminNote : ''}` });
      return res.status(400).json({ error: 'User not found!' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    user.failedAttempts = 0; user.blockUntil = null;
    const prevDevice = user.boundDeviceId;
    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { user.boundDeviceId = deviceId; await user.save(); }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) return res.status(403).json({ error: 'Unauthorized device!' });
    }
    // ★ NEW: Track login metadata
    user.lastLoginIP = req.ip;
    user.lastLoginDevice = deviceId || 'unknown';
    user.lastLoginAt = new Date();
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token; await user.save();
    // ★ NEW: New device login alert
    if (user.role === 'student' && prevDevice && deviceId && prevDevice !== deviceId) {
      sendPushToRollNo(cleanRoll, '🔐 New Device Login', `New login from a different device. If not you, contact admin.`, { type: 'new_device_login' }).catch(() => {});
    }
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role: user.role, branch: user.branch } });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) { const decoded = jwt.decode(token); if (decoded) await User.findOneAndUpdate({ rollNo: decoded.rollNo }, { activeSession: null }); }
    res.json({ message: 'Logged out!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/verify-passcode', async (req, res) => {
  try {
    const { passcode, type } = req.body;
    if (!passcode || !type) return res.status(400).json({ error: 'Passcode and type required.' });
    const doc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() }, enabled: true });
    if (doc) res.json({ valid: true }); else res.status(400).json({ error: 'Invalid or expired.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ACCOUNT REQUESTS ==========
app.post('/api/auth/forgot-password-request', async (req, res) => {
  try {
    const { rollNo, reason } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found' });
    if (await AccountRequest.findOne({ rollNo: cr, type: 'forgot_password', status: 'Pending' })) return res.status(400).json({ error: 'Already pending request' });
    await AccountRequest.create({ rollNo: cr, type: 'forgot_password', reason: reason || 'Forgot password' });
    sendPushToRole('admin', '🔑 Password Reset Request', `${cr} requested password reset.`, { type: 'account_request', rollNo: cr }).catch(() => {});
    res.status(201).json({ message: 'Request submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/device-reset-request', async (req, res) => {
  try {
    const { rollNo, reason } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found' });
    if (await AccountRequest.findOne({ rollNo: cr, type: 'device_reset', status: 'Pending' })) return res.status(400).json({ error: 'Already pending' });
    await AccountRequest.create({ rollNo: cr, type: 'device_reset', reason: reason || 'Device reset' });
    sendPushToRole('admin', '📱 Device Reset Request', `${cr} requested device reset.`, { type: 'account_request', rollNo: cr }).catch(() => {});
    res.status(201).json({ message: 'Request submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { rollNo, currentPassword, newPassword } = req.body;
    if (!rollNo || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: 'Password changed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/change-password-direct', async (req, res) => {
  try {
    const { rollNo, newPassword } = req.body;
    if (!rollNo || !newPassword) return res.status(400).json({ error: 'rollNo and newPassword required' });
    const cr = rollNo.trim().toUpperCase();
    const approved = await AccountRequest.findOne({ rollNo: cr, type: 'forgot_password', status: 'Approved' });
    if (!approved) return res.status(403).json({ error: 'No approved forgot-password request.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
    await User.updateOne({ rollNo: cr }, { $set: { password: await bcrypt.hash(newPassword, 10) } });
    approved.status = 'Used'; await approved.save();
    res.json({ message: 'Password updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/account-requests/check/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    if (!cr) return res.status(400).json({ error: 'rollNo required' });
    const requests = await AccountRequest.find({ rollNo: cr }).sort({ createdAt: -1 }).limit(10);
    res.json({ count: requests.length, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/account-requests/:adminRollNo', async (req, res) => {
  try {
    const adminUser = await User.findOne({ rollNo: req.params.adminRollNo.trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const requests = await AccountRequest.find({}).sort({ createdAt: -1 }).limit(100);
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/account-requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note } = req.body;
    const adminUser = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const r = await AccountRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    r.status = action; r.reviewedBy = adminUser.rollNo; r.adminNote = note || '';
    await r.save();
    if (action === 'Approved' && r.type === 'device_reset') await User.updateOne({ rollNo: r.rollNo }, { $set: { boundDeviceId: null } });
    if (action === 'Approved') {
      const msg = r.type === 'forgot_password' ? 'Your password reset request was approved. Set new password now.' : 'Your device reset request was approved. Try logging in again.';
      sendPushToRollNo(r.rollNo, '✅ Request Approved', msg, { type: 'account_approved' }).catch(() => {});
    } else {
      sendPushToRollNo(r.rollNo, '❌ Request Rejected', `Your ${r.type.replace('_',' ')} request was rejected.${note ? ' Note: ' + note : ''}`, { type: 'account_rejected' }).catch(() => {});
    }
    res.json({ message: `Request ${action}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clear-account-requests', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = await AccountRequest.deleteMany({});
    res.json({ message: `Deleted ${r.deletedCount} account request(s).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clear-pending/:rollNo', async (req, res) => {
  try {
    const cr = (req.params.rollNo || '').trim().toUpperCase();
    const result = await PendingAction.deleteMany({ rollNo: cr });
    res.json({ message: `Cleared ${result.deletedCount} pending action(s) for ${cr}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PROFILE ==========
app.post('/api/student/profile', async (req, res) => {
  try {
    const { rollNo, email, phone, profilePic, semester, branch, dateOfBirth, parentEmail, parentPhone } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (profilePic) user.profilePic = profilePic;
    if (semester) user.semester = semester;
    if (branch) user.branch = branch;
    if (dateOfBirth) user.dateOfBirth = dateOfBirth;
    if (parentEmail) user.parentEmail = parentEmail;
    if (parentPhone) user.parentPhone = parentPhone;
    await user.save();
    res.json({ message: 'Updated!', user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/student/profile/:rollNo', async (req, res) => {
  try {
    const user = await User.findOne({ rollNo: req.params.rollNo.trim().toUpperCase() }).select('-password -activeSession');
    if (!user) return res.status(404).json({ error: 'Not found!' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ADMIN ==========
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo, newPassword } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const hashed = await bcrypt.hash(newPassword || '123456', 10);
    const updated = await User.findOneAndUpdate({ rollNo: targetRollNo.trim().toUpperCase() }, { password: hashed });
    if (!updated) return res.status(404).json({ error: 'User not found!' });
    sendPushToRollNo(targetRollNo, '🔑 Password Reset', 'Your password was reset by admin.', { type: 'password_reset' }).catch(() => {});
    res.json({ message: `Reset done for ${targetRollNo}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/reset-device', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const user = await User.findOne({ rollNo: targetRollNo.trim().toUpperCase() });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    user.boundDeviceId = null; await user.save();
    sendPushToRollNo(targetRollNo, '📱 Device Reset', 'Your device binding was reset. You can login from a new phone.', { type: 'device_reset' }).catch(() => {});
    res.json({ message: `Reset for ${targetRollNo}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/update-rollno', async (req, res) => {
  try {
    const { requesterRollNo, oldRoll, newRoll } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    await User.findOneAndUpdate({ rollNo: oldRoll.trim().toUpperCase() }, { rollNo: newRoll.trim().toUpperCase() });
    await Attendance.updateMany({ rollNo: oldRoll.trim().toUpperCase() }, { rollNo: newRoll.trim().toUpperCase() });
    res.json({ message: 'Updated!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/delete-user', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const t = targetRollNo.trim().toUpperCase();
    await User.findOneAndDelete({ rollNo: t });
    await Attendance.deleteMany({ rollNo: t });
    await TeacherSubject.deleteMany({ teacherRollNo: t });
    await AttendanceRequest.deleteMany({ rollNo: t });
    res.json({ message: `Deleted ${t}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/login-as-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const student = await User.findOne({ rollNo: targetRollNo.trim().toUpperCase() });
    if (!student) return res.status(404).json({ error: 'Not found!' });
    const token = jwt.sign({ id: student._id, rollNo: student.rollNo, name: student.name, role: 'student' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ message: `As ${student.name}`, token, user: { name: student.name, rollNo: student.rollNo, role: 'student' }, isImpersonating: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE REQUEST ==========
app.post('/api/requests/submit', async (req, res) => {
  try {
    const { rollNo, date, lectureType, subject, subjects, period, reason } = req.body;
    if (!rollNo || !date || !lectureType) return res.status(400).json({ error: 'rollNo, date, lectureType required.' });
    if (!['full_day', 'single_lecture'].includes(lectureType)) return res.status(400).json({ error: 'Invalid lectureType.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const todayStr = getISTDateString(new Date());
    if (date > todayStr) return res.status(400).json({ error: `🚫 Future date not allowed (${date}).` });
    if (date === todayStr) { const istHour = getISTHour(new Date()); if (istHour < COLLEGE_CLOSE_HOUR) return res.status(400).json({ error: `⏰ Today's request only after 3 PM.`, code: 'USE_LIVE_MARKING' }); }
    const ds = await checkDateStatus(date);
    if (ds.isBlocked) return res.status(400).json({ error: ds.type === 'WEEKEND' ? `College closed on ${ds.dayName}.` : `Holiday: ${ds.holiday || 'College closed'}.` });
    if (lectureType !== 'full_day' && !subject) return res.status(400).json({ error: 'subject required.' });
    const existing = await AttendanceRequest.findOne({ rollNo: cr, date, lectureType, status: 'Pending' });
    if (existing) return res.status(400).json({ error: `Already pending for ${date}.`, existing });
    const isPast = date < todayStr;
    const newReq = await AttendanceRequest({ rollNo: cr, studentName: user.name, branch: user.branch || 'CSE', date, lectureType, subject: subject ? mapToCanonical(subject) : null, subjects: (subjects || []).map(mapToCanonical), period: period || null, reason: reason || `Attendance request (${isPast ? 'past date' : 'after 3 PM'})`, location: null, distanceFromCollege: null, locationVerified: false, isPastDate: isPast, status: 'Pending' });
    await newReq.save();
    sendPushToRole('admin', '📩 New Attendance Request', `${user.name} (${cr}) requested ${lectureType.replace('_',' ')} for ${date}`, { type: 'attendance_request', rollNo: cr }).catch(() => {});
    res.status(201).json({ message: `✅ Request submitted.`, request: newReq });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ========== LIVE MARKING ==========
app.post('/api/attendance/mark-live', async (req, res) => {
  try {
    const { rollNo, latitude, longitude, passcode, type } = req.body;
    if (!rollNo || !passcode || !type) return res.status(400).json({ error: 'rollNo, passcode, type required.' });
    if (!['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const branch = user.branch || 'CSE';
    const todayStr = getISTDateString(new Date());
    const ds = await checkDateStatus(todayStr);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    if (getISTHour(new Date()) >= COLLEGE_CLOSE_HOUR) return res.status(400).json({ error: `⏰ College hours over.` });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) {
      await incrementFailedAttempts(cr);
      if (user.failedAttempts >= 2 && user.failedAttempts < 5) {
        sendPushToRollNo(cr, '📍 Location Alert', `Attempt ${user.failedAttempts}: Out of campus. Move closer to college.`, { type: 'location_failed' }).catch(() => {});
      }
      return res.status(400).json({ error: `❌ ${lc.distance}m away.` });
    }
    const passDoc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() }, enabled: true });
    if (!passDoc) return res.status(400).json({ error: '❌ Invalid passcode.' });
    if (type === 'full_day') {
      const tt = getTimetableForBranch(branch);
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = days[new Date().getDay()];
      const acadSet = new Set();
      (tt[dayName] || []).forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Sports")) acadSet.add(s); });
      const acad = Array.from(acadSet);
      if (!acad.length) return res.status(400).json({ error: 'No academic subjects today.' });
      let marked = 0, skipped = 0;
      for (const sub of acad) {
        try { await Attendance.create({ rollNo: cr, studentName: user.name, subject: sub, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); marked++; }
        catch (e) { if (e.code === 11000) skipped++; }
      }
      user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
      user.failedAttempts = 0; user.blockUntil = null; await user.save();
      if (marked === 0) return res.status(400).json({ error: `Already marked.` });
      checkAttendanceMilestone(cr).catch(() => {});
      return res.status(201).json({ message: `✅ ${marked} marked (${skipped} already). ${lc.distance}m.`, marked, skipped });
    }
    const period = getCurrentPeriod(branch);
    if (!period) return res.status(400).json({ error: '⏰ No active lecture.' });
    const activeSubj = mapToCanonical(period.subject);
    try { await Attendance.create({ rollNo: cr, studentName: user.name, subject: activeSubj, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); }
    catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    checkAttendanceMilestone(cr).catch(() => {});
    res.status(201).json({ message: `✅ ${activeSubj} marked. ${lc.distance}m.`, subject: activeSubj });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ========== REQUESTS VIEW/REVIEW ==========
app.get('/api/requests/my/:rollNo', async (req, res) => {
  try { res.json(await AttendanceRequest.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ createdAt: -1 }).limit(50)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/requests/all/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only.' });
    let filter = {};
    if (req1.role === 'faculty') filter.branch = req1.branch || 'CSE';
    if (req.query.status) filter.status = req.query.status;
    if (req.query.rollNo) filter.rollNo = req.query.rollNo.trim().toUpperCase();
    if (req.query.date) filter.date = req.query.date;
    res.json({ count: await AttendanceRequest.countDocuments(filter), requests: await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(200) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/requests/pending/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only.' });
    let filter = { status: 'Pending' };
    if (req1.role === 'faculty') filter.branch = req1.branch || 'CSE';
    res.json({ count: await AttendanceRequest.countDocuments(filter), requests: await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(200) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note, approvedSubjects } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only.' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
    const request = await AttendanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found.' });
    if (request.status !== 'Pending') return res.status(400).json({ error: `Already ${request.status}.` });
    if (action === 'Approved') {
      const b = request.branch || 'CSE';
      const dateStatus = await checkDateStatus(request.date);
      if (dateStatus.isBlocked) return res.status(400).json({ error: `Cannot approve — blocked date.` });
      const schedule = getScheduleForDate(request.date, b);
      let subjectsToMark = [];
      if (request.lectureType === 'full_day') subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
      else if (request.lectureType === 'single_lecture') subjectsToMark = request.subject ? [mapToCanonical(request.subject)] : [];
      if (approvedSubjects && Array.isArray(approvedSubjects) && approvedSubjects.length > 0) subjectsToMark = approvedSubjects.map(mapToCanonical);
      let markedCount = 0;
      const markedSubjects = [];
      for (const sub of subjectsToMark) {
        try { const exists = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date }); if (!exists) { await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: null, ipAddress: 'request-approved', isVerified: false, branch: b }); markedCount++; markedSubjects.push(sub); } }
        catch (e) { if (e.code !== 11000) console.warn(e.message); }
      }
      request.status = markedSubjects.length === subjectsToMark.length ? 'Approved' : 'Partially Approved';
      request.reviewedBy = req1.rollNo; request.adminNote = note || '';
      request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: markedSubjects });
      await request.save();
      sendPushToRollNo(request.rollNo, '✅ Attendance Request Approved', `${request.date} — ${markedCount} lecture(s) marked.`, { type: 'request_approved' }).catch(() => {});
      res.json({ message: `✅ Approved. ${markedCount} marked.`, request, markedCount, markedSubjects, totalRequested: subjectsToMark.length });
    } else {
      request.status = 'Rejected'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
      request.reviewHistory.push({ action: 'Rejected', by: req1.rollNo, at: new Date(), note: note || '' });
      await request.save();
      sendPushToRollNo(request.rollNo, '❌ Attendance Request Rejected', `${request.date}${note ? ' — ' + note : ''}`, { type: 'request_rejected' }).catch(() => {});
      res.json({ message: `❌ Rejected.`, request });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/requests/bulk-review', async (req, res) => {
  try {
    const { requesterRollNo, requestIds, action, note } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    if (!Array.isArray(requestIds) || !requestIds.length) return res.status(400).json({ error: 'requestIds required.' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
    const results = []; let totalMarked = 0;
    for (const id of requestIds) {
      try {
        const request = await AttendanceRequest.findById(id);
        if (!request || request.status !== 'Pending') { results.push({ id, error: 'Not pending' }); continue; }
        if (action === 'Rejected') {
          request.status = 'Rejected'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
          request.reviewHistory.push({ action: 'Rejected', by: req1.rollNo, at: new Date(), note: note || '' });
          await request.save();
          sendPushToRollNo(request.rollNo, '❌ Request Rejected', `${request.date}`, { type: 'request_rejected' }).catch(() => {});
          results.push({ id, status: 'Rejected' });
        } else {
          const b = request.branch || 'CSE';
          const schedule = getScheduleForDate(request.date, b);
          let subjectsToMark = [];
          if (request.lectureType === 'full_day') subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
          else if (request.lectureType === 'single_lecture' && request.subject) subjectsToMark = [mapToCanonical(request.subject)];
          let marked = 0;
          for (const sub of subjectsToMark) { try { const ex = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date }); if (!ex) { await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: null, ipAddress: 'bulk-approve', isVerified: false, branch: b }); marked++; } } catch (e) {} }
          request.status = 'Approved'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
          request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: subjectsToMark });
          await request.save();
          totalMarked += marked;
          sendPushToRollNo(request.rollNo, '✅ Request Approved', `${request.date} — ${marked} lecture(s) marked.`, { type: 'request_approved' }).catch(() => {});
          results.push({ id, status: 'Approved', marked });
        }
      } catch (e) { results.push({ id, error: e.message }); }
    }
    res.json({ message: `Bulk done. ${totalMarked} marked.`, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/clear-requests', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = await AttendanceRequest.deleteMany({});
    res.json({ message: `Deleted ${r.deletedCount} attendance request(s).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PASSCODE TOGGLE ==========
app.post('/api/admin/passcode/toggle', async (req, res) => {
  try {
    const { requesterRollNo, enabled } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean.' });
    await Passcode.updateMany({}, { $set: { enabled } });
    res.json({ message: `Passcode ${enabled ? 'ENABLED' : 'DISABLED'}.`, enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/passcode/status/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    const total = await Passcode.countDocuments({});
    const enabledCount = await Passcode.countDocuments({ enabled: true });
    const activePublic = await Passcode.find({ published: true, enabled: true, isPublic: true, expiresAt: { $gt: new Date() } }).select('type passcode expiresAt');
    res.json({ total, enabledCount, systemEnabled: enabledCount > 0 || total === 0, activePublic });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== TEACHER SUBJECTS ==========
app.post('/api/admin/assign-subject', async (req, res) => {
  try {
    const { requesterRollNo, teacherRollNo, subject } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const ct = teacherRollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: ct, role: 'faculty' });
    if (!teacher) return res.status(404).json({ error: 'Faculty not found!' });
    const canon = mapToCanonical(subject);
    if (await TeacherSubject.findOne({ teacherRollNo: ct, subject: canon })) return res.status(400).json({ error: 'Already assigned.' });
    await TeacherSubject.create({ teacherRollNo: ct, subject: canon, assignedBy: requesterRollNo });
    res.json({ message: `Assigned to ${ct}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/remove-subject', async (req, res) => {
  try {
    const { requesterRollNo, teacherRollNo, subject } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    await TeacherSubject.findOneAndDelete({ teacherRollNo: teacherRollNo.trim().toUpperCase(), subject: mapToCanonical(subject) });
    res.json({ message: 'Removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/teacher/subjects/:rollNo', async (req, res) => {
  try { res.json((await TeacherSubject.find({ teacherRollNo: req.params.rollNo.trim().toUpperCase() })).map(a => mapToCanonical(a.subject))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/teacher/students/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cr, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Teacher not found!' });
    const subjects = await TeacherSubject.find({ teacherRollNo: cr }).distinct('subject');
    if (!subjects.length) return res.json([]);
    const records = await Attendance.find({ subject: { $in: subjects } }).distinct('rollNo');
    res.json(await User.find({ rollNo: { $in: records }, role: 'student' }).select('name rollNo'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/teacher/class-average/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cr, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Teacher not found!' });
    const subjects = await TeacherSubject.find({ teacherRollNo: cr }).distinct('subject');
    if (!subjects.length) return res.json({ average: 0 });
    const records = await Attendance.find({ subject: { $in: subjects } });
    const present = records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
    res.json({ average: records.length > 0 ? Math.round((present / records.length) * 100) : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/teacher/mark-attendance', async (req, res) => {
  try {
    const { rollNo, subject, latitude, longitude, studentRollNo } = req.body;
    const todayDate = getISTDateString(new Date());
    const ds = await checkDateStatus(todayDate);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const cr = rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cr, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Faculty only.' });
    const subj = mapToCanonical(subject);
    if (!(await TeacherSubject.findOne({ teacherRollNo: cr, subject: subj }))) return res.status(403).json({ error: `Not authorized.` });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) return res.status(400).json({ error: `Outside (${lc.distance}m)` });
    if (!studentRollNo) return res.status(400).json({ error: 'Student roll required.' });
    const cs = studentRollNo.trim().toUpperCase();
    const su = await User.findOne({ rollNo: cs, role: 'student' });
    if (!su) return res.status(404).json({ error: 'Student not found!' });
    if (await Attendance.findOne({ rollNo: cs, subject: subj, date: todayDate })) return res.status(400).json({ error: 'Already marked.' });
    await new Attendance({ rollNo: cs, studentName: su.name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: su.branch || 'CSE', markedBy: cr }).save();
    checkAttendanceMilestone(cs).catch(() => {});
    res.status(201).json({ message: `✅ Marked ${su.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/teacher/bulk-mark-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates, status } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase(), role: 'faculty' });
    if (!req1) return res.status(403).json({ error: 'Faculty only.' });
    if (!studentRollNos || !Array.isArray(studentRollNos) || !studentRollNos.length) return res.status(400).json({ error: 'At least 1 roll no required.' });
    if (!dates || !Array.isArray(dates) || !dates.length) return res.status(400).json({ error: 'At least 1 date required.' });
    for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: `Invalid date: ${d}` });
    const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject');
    if (!subjects.length) return res.status(400).json({ error: 'No subjects assigned.' });
    const students = await User.find({ rollNo: { $in: studentRollNos }, role: 'student' });
    if (!students.length) return res.status(404).json({ error: 'No students.' });
    const results = []; let totalMarked = 0, totalSkipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE';
      let mk = 0, sk = 0;
      for (const date of dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        const dayName = ds.dayName;
        const daySubjects = (getTimetableForBranch(b)[dayName] || []).map(mapToCanonical).filter(x => subjects.includes(x));
        const uniq = [...new Set(daySubjects.filter(x => !x.includes('LIB') && !x.includes('Sports')))];
        for (const sub of uniq) {
          try { const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date }); if (!ex) { await Attendance.create({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: status || 'Present', location: null, ipAddress: 'fac-bulk', isVerified: false, branch: b, markedBy: requesterRollNo }); mk++; } else sk++; }
          catch (err) { if (err.code === 11000) sk++; }
        }
      }
      results.push({ rollNo: s.rollNo, branch: b, marked: mk, skipped: sk });
      totalMarked += mk; totalSkipped += sk;
    }
    res.json({ message: `✅ ${totalMarked} new, ${totalSkipped} skipped.`, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/teacher/bulk-delete-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase(), role: 'faculty' });
    if (!req1) return res.status(403).json({ error: 'Faculty only.' });
    if (!studentRollNos || !studentRollNos.length) return res.status(400).json({ error: 'Roll nos required.' });
    if (!dates || !dates.length) return res.status(400).json({ error: 'Dates required.' });
    const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject');
    if (!subjects.length) return res.status(400).json({ error: 'No subjects assigned.' });
    const r = await Attendance.deleteMany({ rollNo: { $in: studentRollNos }, date: { $in: dates }, subject: { $in: subjects } });
    res.json({ message: `✅ Deleted ${r.deletedCount}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PASSCODE GENERATE (existing — 100% as-is) ==========
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type, force, publish, durationMinutes, isPublic } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'User not found!' });
    if (req1.role === 'admin') { }
    else if (req1.role === 'faculty' && type === 'single_lecture') { }
    else return res.status(403).json({ error: 'Access Denied.' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const todayStr = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayStr);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.type === 'WEEKEND' ? `📅 ${dateStatus.dayName}: Closed.` : `🎉 Holiday.`, blocked: true });
    const publishFlag = !!publish;
    const pubPublic = isPublic === undefined ? true : !!isPublic;
    const now = new Date();
    const durationMin = parseInt(durationMinutes) || (type === 'full_day' ? 1440 : 30);
    if (type === 'single_lecture') {
      const branch = req1.branch || 'CSE';
      const period = getCurrentPeriod(branch);
      if (!period) return res.status(400).json({ error: 'No active lecture.' });
      const ds = getISTDateString(now);
      const key = `single_lecture_${ds}_${period.start}`;
      if (publishFlag && !force) {
        const existing = await Passcode.findOne({ key, type: 'single_lecture', enabled: true, published: false, expiresAt: { $gt: new Date() } });
        if (existing) {
          existing.published = true; existing.publishedAt = now; existing.publishedBy = req1.rollNo;
          existing.durationMinutes = durationMin; existing.expiresAt = new Date(now.getTime() + durationMin * 60 * 1000);
          await existing.save();
          sendPushToAllStudents('🔐 Lecture Passcode Published', `Passcode: ${existing.passcode} — valid ${durationMin} min`, { type: 'passcode', passcodeType: 'single_lecture' }).catch(() => {});
          return res.json({ message: 'Published', passcode: existing.passcode, type, expiresAt: existing.expiresAt, published: true, isPublic: pubPublic, durationMinutes: durationMin });
        }
      }
      await Passcode.deleteMany({ key, type: 'single_lecture' });
      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const expiry = new Date(now.getTime() + durationMin * 60 * 1000);
      const newDoc = await new Passcode({ passcode, type, key, expiresAt: expiry, published: publishFlag, isPublic: pubPublic, enabled: true, publishedAt: publishFlag ? now : null, publishedBy: publishFlag ? req1.rollNo : null, durationMinutes: publishFlag ? durationMin : null }).save();
      await Passcode.deleteMany({ type: 'single_lecture', expiresAt: { $lt: new Date() } });
      if (publishFlag) sendPushToAllStudents('🔐 Lecture Passcode Published', `Passcode: ${newDoc.passcode} — valid ${durationMin} min`, { type: 'passcode', passcodeType: 'single_lecture' }).catch(() => {});
      return res.json({ message: force ? 'Changed' : (publishFlag ? 'Published' : 'Generated'), passcode: newDoc.passcode, type, expiresAt: newDoc.expiresAt, changed: !!force, published: publishFlag, isPublic: pubPublic, durationMinutes: durationMin });
    }
    if (type === 'full_day') {
      const ds = getISTDateString(now);
      const key = `full_day_${ds}`;
      if (publishFlag && !force) {
        const existing = await Passcode.findOne({ key, type: 'full_day', enabled: true, published: false, expiresAt: { $gt: new Date() } });
        if (existing) {
          existing.published = true; existing.publishedAt = now; existing.publishedBy = req1.rollNo;
          existing.durationMinutes = durationMin; existing.expiresAt = new Date(now.getTime() + durationMin * 60 * 1000);
          await existing.save();
          sendPushToAllStudents('📅 Full Day Passcode Published', `Passcode: ${existing.passcode} — valid ${durationMin} min`, { type: 'passcode', passcodeType: 'full_day' }).catch(() => {});
          return res.json({ message: 'Published', passcode: existing.passcode, type, expiresAt: existing.expiresAt, published: true, isPublic: pubPublic, durationMinutes: durationMin });
        }
      }
      await Passcode.deleteMany({ key, type: 'full_day' });
      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiry = publishFlag ? new Date(now.getTime() + durationMin * 60 * 1000) : (() => { const e = new Date(now); e.setHours(23, 59, 59, 999); return e; })();
      const newDoc = await new Passcode({ passcode, type, key, expiresAt: expiry, published: publishFlag, isPublic: pubPublic, enabled: true, publishedAt: publishFlag ? now : null, publishedBy: publishFlag ? req1.rollNo : null, durationMinutes: publishFlag ? durationMin : null }).save();
      await Passcode.deleteMany({ type: 'full_day', expiresAt: { $lt: new Date() } });
      if (publishFlag) sendPushToAllStudents('📅 Full Day Passcode Published', `Passcode: ${newDoc.passcode} — valid ${durationMin} min`, { type: 'passcode', passcodeType: 'full_day' }).catch(() => {});
      return res.json({ message: force ? 'Changed' : (publishFlag ? 'Published' : 'Generated'), passcode: newDoc.passcode, type, expiresAt: newDoc.expiresAt, changed: !!force, published: publishFlag, isPublic: pubPublic, durationMinutes: durationMin });
    }
    res.status(400).json({ error: 'Invalid type' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/current-passcode/:type/:requesterRollNo', async (req, res) => {
  try {
    const { type, requesterRollNo } = req.params;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'Not found' });
    if (req1.role !== 'admin' && req1.role !== 'faculty') return res.status(403).json({ error: 'Access Denied' });
    if (type !== 'single_lecture') return res.status(400).json({ error: 'Only single_lecture' });
    const period = getCurrentPeriod(req1.branch || 'CSE');
    if (!period) return res.json({ passcode: null, message: 'No active period' });
    const ds = getISTDateString(new Date());
    const key = `single_lecture_${ds}_${period.start}`;
    const doc = await Passcode.findOne({ key, type: 'single_lecture', expiresAt: { $gt: new Date() } });
    if (doc) return res.json({ passcode: doc.passcode, expiresAt: doc.expiresAt, published: doc.published, isPublic: doc.isPublic });
    return res.json({ passcode: null, message: 'No passcode' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/passcode/public/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const doc = await Passcode.findOne({ type, published: true, enabled: true, isPublic: true, expiresAt: { $gt: new Date() } }).sort({ publishedAt: -1 });
    if (!doc) return res.json({ passcode: null, message: 'No active passcode.' });
    res.json({ passcode: doc.passcode, type, expiresAt: doc.expiresAt, durationMinutes: doc.durationMinutes, publishedAt: doc.publishedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEGACY MARKING (existing — 100% as-is) ==========
app.post('/api/attendance/mark-lecture', async (req, res) => {
  try {
    const { rollNo, subject, latitude, longitude, passcode } = req.body;
    if (!rollNo || !subject || !passcode) return res.status(400).json({ error: 'Missing fields' });
    const todayDate = getISTDateString(new Date());
    const ds = await checkDateStatus(todayDate);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const cr = rollNo.trim().toUpperCase();
    const bc = await checkStudentBlocked(cr);
    if (bc.blocked) return res.status(403).json({ error: bc.message });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const period = getCurrentPeriod(user.branch || 'CSE');
    if (!period) return res.status(400).json({ error: 'No active period.' });
    const ns = mapToCanonical(subject), nc = mapToCanonical(period.subject);
    if (ns !== nc) return res.status(400).json({ error: 'Subject mismatch.' });
    const key = `single_lecture_${todayDate}_${period.start}`;
    const doc = await Passcode.findOne({ key, type: 'single_lecture', passcode, expiresAt: { $gt: new Date() }, enabled: true });
    if (!doc) return res.status(400).json({ error: 'Invalid passcode.' });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `Outside (${lc.distance}m)` }); }
    try { await new Attendance({ rollNo: cr, studentName: user.name, subject: ns, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: user.branch || 'CSE' }).save(); }
    catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    checkAttendanceMilestone(cr).catch(() => {});
    res.status(201).json({ message: `✅ Marked ${subject}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude, passcode } = req.body;
    if (!passcode) return res.status(400).json({ error: 'Passcode required!' });
    const todayDate = getISTDateString(new Date());
    const ds = await checkDateStatus(todayDate);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const cr = rollNo.trim().toUpperCase();
    const bc = await checkStudentBlocked(cr);
    if (bc.blocked) return res.status(403).json({ error: bc.message });
    const doc = await Passcode.findOne({ passcode: passcode.trim(), type: 'full_day', expiresAt: { $gt: new Date() }, enabled: true });
    if (!doc) return res.status(400).json({ error: 'Invalid/expired.' });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `Outside (${lc.distance}m)` }); }
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const branch = user.branch || 'CSE';
    const tt = getTimetableForBranch(branch);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[new Date().getDay()];
    const acadSet = new Set();
    (tt[dayName] || []).forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Sports")) acadSet.add(s); });
    const acad = Array.from(acadSet);
    let marked = 0, skipped = 0;
    for (const sub of acad) {
      try { await Attendance.create({ rollNo: cr, studentName: name, subject: sub, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); marked++; }
      catch (err) { if (err.code === 11000) skipped++; }
    }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    if (marked === 0 && skipped > 0) return res.status(400).json({ error: `All ${skipped} already marked today.` });
    if (marked === 0) return res.status(400).json({ error: 'No academic subjects today.' });
    checkAttendanceMilestone(cr).catch(() => {});
    res.status(201).json({ message: `✅ Marked ${marked} new (${skipped} already).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== NOTICES (existing + updated) ==========
app.get('/api/notices', async (req, res) => {
  try { res.json(await Notice.find().sort({ date: -1 }).limit(10)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!message || message.trim() === "") { await Notice.deleteMany({}); return res.json({ message: 'Cleared!' }); }
    const nn = await new Notice({ title: title || 'Announcement', message, postedBy: requesterRollNo }).save();
    // ★ Updated: Send to all users (not just students)
    sendPushToAllUsers(`📢 ${title || 'Announcement'}`, message, { type: 'notice' }).catch(() => {});
    res.status(201).json({ message: 'Published!', notice: nn });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HOLIDAYS (existing + NEW notifications) ==========
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const parts = date.split('-');
    const dobj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dobj < SEMESTER_START) return res.status(400).json({ error: 'Before semester!' });
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dn = days[dobj.getDay()];
    if (dn === 'Saturday' || dn === 'Sunday') return res.status(400).json({ error: 'Weekend!' });
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'Holiday' }, { upsert: true, new: true });
    // ★ NEW: Notify all users
    sendPushToAllUsers('🎉 Holiday Announced', `${date} — ${reason || 'Holiday'}. College will remain closed.`, { type: 'holiday_added', date }).catch(() => {});
    res.json({ message: `✅ ${date}: ${reason}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/holiday/:date', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const result = await Holiday.findOneAndDelete({ date: req.params.date });
    if (!result) return res.status(404).json({ error: 'Not found!' });
    // ★ NEW: Notify cancellation
    sendPushToAllUsers('⚠️ Holiday Cancelled', `${req.params.date} holiday removed. College will remain OPEN.`, { type: 'holiday_cancelled', date: req.params.date }).catch(() => {});
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/holidays', async (req, res) => {
  try { res.json(await Holiday.find()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/date-status/:date', async (req, res) => {
  try { res.json(await checkDateStatus(req.params.date)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== CALENDAR DAY INFO (existing — 100% as-is) ==========
app.get('/api/calendar/day/:rollNo/:date', async (req, res) => {
  try {
    const cr = (req.params.rollNo || '').trim().toUpperCase();
    const ds = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return res.status(400).json({ error: 'Invalid date.' });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const branch = user.branch || 'CSE';
    const parts = ds.split('-');
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[d.getDay()];
    const isWeekend = (d.getDay() === 0 || d.getDay() === 6);
    const todayStr = getISTDateString(new Date());
    const isFuture = ds > todayStr;
    const isToday = ds === todayStr;
    const isBeforeSemester = d < SEMESTER_START;
    const holidayDoc = await Holiday.findOne({ date: ds });
    const isHoliday = !!holidayDoc;
    const holidayReason = holidayDoc ? holidayDoc.reason : null;
    const schedule = getScheduleForDate(ds, branch);
    const scheduledSlots = (schedule.schedule || []).filter(s => s.period !== 'LUNCH');
    const academicSlots = scheduledSlots.filter(s => !mapToCanonical(s.subject).includes('LIB') && !mapToCanonical(s.subject).includes('Sports'));
    const records = await Attendance.find({ rollNo: cr, date: ds }).lean();
    const attendedRecs = records.filter(r => r.status === 'Present' || r.status === 'Duty Leave');
    const mappedRecords = records.map(r => ({ subject: mapToCanonical(r.subject), status: r.status, verified: r.isVerified, time: r.createdAt }));
    let state = 'working';
    if (isBeforeSemester) state = 'before-semester';
    else if (isFuture) state = 'future';
    else if (isWeekend) state = 'weekend';
    else if (isHoliday) state = 'holiday';
    else if (records.length > 0 && attendedRecs.length === 0) state = 'absent';
    else if (attendedRecs.length > 0) state = 'present';
    res.json({ date: ds, dayName, branch, state, isWeekend, isHoliday, holidayReason, isFuture, isToday, isBeforeSemester, scheduledLectures: academicSlots.map(s => ({ period: s.period, start: s.start, end: s.end, subject: mapToCanonical(s.subject), faculty: s.faculty })), attended: attendedRecs.length, conducted: academicSlots.length, records: mappedRecords });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ========== STUDENT TREND (existing — 100% as-is) ==========
app.get('/api/student/trend/:rollNo', async (req, res) => {
  try {
    const cr = (req.params.rollNo || '').trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const branch = user.branch || 'CSE';
    const tt = getTimetableForBranch(branch);
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => (h.date || '').toString().split('T')[0]));
    const todayStr = getISTDateString(new Date());
    const mode = (req.query.mode || 'monthly').toLowerCase();
    async function computeDay(dateStr, dayName) {
      const acad = (tt[dayName] || []).map(e => mapToCanonical(e.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
      const conducted = acad.length;
      if (conducted === 0) return { attended: 0, conducted: 0 };
      const recs = await Attendance.find({ rollNo: cr, date: dateStr, status: { $in: ['Present', 'Duty Leave'] } }).lean();
      const presentSet = new Set(recs.map(r => mapToCanonical(r.subject)));
      let attended = 0;
      acad.forEach(sub => { if (presentSet.has(sub)) attended++; });
      return { attended, conducted };
    }
    if (mode === 'monthly') {
      const months = [6, 7, 8, 9, 10, 11];
      const labels = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const now = new Date(); const nowMonth = now.getMonth();
      const data = [];
      for (let i = 0; i < months.length; i++) {
        const m = months[i];
        if (m > nowMonth) { data.push({ label: labels[i], month: m, attended: 0, conducted: 0, percentage: 0, future: true }); continue; }
        const y = 2026;
        const dim = new Date(y, m + 1, 0).getDate();
        let att = 0, cond = 0;
        for (let day = 1; day <= dim; day++) {
          const dt = new Date(y, m, day);
          const ds = getISTDateString(dt);
          if (ds > todayStr) continue;
          if (dt < SEMESTER_START) continue;
          const dow = dt.getDay();
          if (dow === 0 || dow === 6) continue;
          if (holidaySet.has(ds)) continue;
          const r = await computeDay(ds, dayNameMap[dow]);
          att += r.attended; cond += r.conducted;
        }
        data.push({ label: labels[i], month: m, attended: att, conducted: cond, percentage: cond > 0 ? Math.round((att / cond) * 100) : 0, future: false });
      }
      return res.json({ mode: 'monthly', branch, data });
    }
    const month = parseInt(req.query.month);
    if (isNaN(month) || month < 0 || month > 11) return res.status(400).json({ error: 'month (0-11) required' });
    const y = 2026;
    const dim = new Date(y, month + 1, 0).getDate();
    const data = [];
    for (let day = 1; day <= dim; day++) {
      const dt = new Date(y, month, day);
      const ds = getISTDateString(dt);
      const dow = dt.getDay();
      const label = String(day);
      if (ds > todayStr) { data.push({ label, date: ds, attended: 0, conducted: 0, percentage: 0, state: 'future' }); continue; }
      if (dt < SEMESTER_START) { data.push({ label, date: ds, attended: 0, conducted: 0, percentage: 0, state: 'before-semester' }); continue; }
      if (dow === 0 || dow === 6) { data.push({ label, date: ds, attended: 0, conducted: 0, percentage: 0, state: 'weekend' }); continue; }
      if (holidaySet.has(ds)) { data.push({ label, date: ds, attended: 0, conducted: 0, percentage: 0, state: 'holiday' }); continue; }
      const r = await computeDay(ds, dayNameMap[dow]);
      data.push({ label, date: ds, attended: r.attended, conducted: r.conducted, percentage: r.conducted > 0 ? Math.round((r.attended / r.conducted) * 100) : 0, state: r.conducted === 0 ? 'no-lectures' : (r.attended === r.conducted ? 'full' : (r.attended === 0 ? 'absent' : 'partial')) });
    }
    return res.json({ mode: 'daily', month, branch, data });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ========== DASHBOARD (existing — 100% as-is) ==========
app.get('/api/admin/dashboard-stats/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const totalStudents = await User.countDocuments({ role: 'student' });
    const todayDate = getISTDateString(new Date());
    const todayPresentStudents = await Attendance.distinct('rollNo', { date: todayDate, status: 'Present' });
    const pdetails = await Attendance.find({ date: todayDate, status: 'Present' }).select('rollNo studentName').lean();
    const uniq = {};
    pdetails.forEach(s => { if (!uniq[s.rollNo]) uniq[s.rollNo] = { rollNo: s.rollNo, name: s.studentName }; });
    const allStudents = await User.find({ role: 'student' }).select('rollNo');
    const allRoll = allStudents.map(s => s.rollNo);
    const pSet = new Set(todayPresentStudents);
    const absent = allRoll.filter(r => !pSet.has(r));
    const totalAtt = await Attendance.countDocuments();
    const presentCount = await Attendance.countDocuments({ status: 'Present' });
    const overallPct = totalAtt > 0 ? Math.round((presentCount / totalAtt) * 100) : 0;
    const workingDaysSoFar = await getWorkingDays(SEMESTER_START, new Date());
    const totalWorkingDaysSemester = await getWorkingDays(SEMESTER_START, SEMESTER_END);
    const pendingRequests = await AttendanceRequest.countDocuments({ status: 'Pending' });
    res.json({ totalStudents, todayPresent: todayPresentStudents.length, todayAbsent: absent.length, overallAttendance: totalAtt, overallPct, todayPresentStudents: Object.values(uniq), workingDaysSoFar, totalWorkingDaysSemester, pendingRequests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/all-users/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await User.find().select('name rollNo role boundDeviceId email phone semester branch profilePic facultySubject dateOfBirth').sort({ rollNo: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/faculty/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await User.find({ role: 'faculty' }).select('name rollNo email phone facultySubject').sort({ rollNo: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE VIEW (existing — 100% as-is) ==========
app.get('/api/attendance/student/:rollNo/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty';
    if (!isA && !isT) return res.status(403).json({ error: 'Access Denied' });
    const cr = req.params.rollNo.trim().toUpperCase();
    let records = await Attendance.find({ rollNo: cr }).sort({ date: -1 });
    if (isT) { const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject'); records = records.filter(r => subs.includes(mapToCanonical(r.subject))); }
    records = records.map(r => { r.subject = mapToCanonical(r.subject); return r; });
    res.json(records);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty';
    if (!isA && !isT) return res.status(403).json({ error: 'Access Denied' });
    const rec = await Attendance.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (isT) { const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject'); if (!subs.includes(mapToCanonical(rec.subject))) return res.status(403).json({ error: 'Not authorized.' }); }
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/attendance/update/:id', async (req, res) => {
  try {
    const { status, requesterRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty';
    if (!isA && !isT) return res.status(403).json({ error: 'Access Denied' });
    const rec = await Attendance.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (isT) { const subs = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject'); if (!subs.includes(mapToCanonical(rec.subject))) return res.status(403).json({ error: 'Not authorized.' }); }
    rec.status = status; await rec.save();
    res.json({ message: 'Updated!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/attendance/delete-day/:rollNo/:date/:requesterRollNo', async (req, res) => {
  try {
    const { rollNo, date, requesterRollNo } = req.params;
    const cr = rollNo.trim().toUpperCase(), cd = date.trim();
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty';
    if (!isA && !isT) return res.status(403).json({ error: 'Access Denied' });
    let q = { rollNo: cr, date: cd };
    if (isT) { const subs = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject'); q.subject = { $in: subs }; }
    const result = await Attendance.deleteMany(q);
    if (result.deletedCount === 0) return res.status(404).json({ error: 'No records.' });
    res.json({ message: `Deleted ${result.deletedCount}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== MONTHLY SUMMARY (existing — 100% as-is) ==========
app.get('/api/student/monthly-summary/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const { month } = req.query;
    if (month === undefined || isNaN(parseInt(month))) return res.status(400).json({ error: 'Month (0-11) required' });
    const m = parseInt(month);
    if (m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const branch = user.branch || 'CSE';
    const tt = getTimetableForBranch(branch);
    const startD = new Date(2026, m, 1);
    const endD = new Date(2026, m + 1, 0);
    const startStr = getISTDateString(startD);
    const endStr = getISTDateString(endD);
    const semesterStartStr = getISTDateString(SEMESTER_START);
    const effectiveStartStr = startStr < semesterStartStr ? semesterStartStr : startStr;
    const records = await Attendance.find({ rollNo: cr, date: { $gte: effectiveStartStr, $lte: endStr } }).lean();
    const subSet = new Set();
    let totalConducted = 0;
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const holidaySet = new Set((await Holiday.find({ date: { $gte: startStr, $lte: endStr } })).map(h => (h.date || '').toString().split('T')[0]));
    const todayStr = getISTDateString(new Date());
    let cur = new Date(startD);
    while (cur <= endD) {
      const ds = getISTDateString(cur);
      if (ds > todayStr) { cur.setDate(cur.getDate() + 1); continue; }
      if (ds < semesterStartStr) { cur.setDate(cur.getDate() + 1); continue; }
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) { const dayName = dayNameMap[dow]; (tt[dayName] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (!sub.includes('Sports') && !sub.includes('LIB')) { subSet.add(sub); totalConducted++; } }); }
      cur.setDate(cur.getDate() + 1);
    }
    const stats = {};
    subSet.forEach(sub => { stats[sub] = { total: 0, present: 0 }; });
    cur = new Date(startD);
    while (cur <= endD) {
      const ds = getISTDateString(cur);
      if (ds > todayStr) { cur.setDate(cur.getDate() + 1); continue; }
      if (ds < semesterStartStr) { cur.setDate(cur.getDate() + 1); continue; }
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) { const dayName = dayNameMap[dow]; (tt[dayName] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (stats[sub]) stats[sub].total++; }); }
      cur.setDate(cur.getDate() + 1);
    }
    records.forEach(rec => { const sub = mapToCanonical(rec.subject); if (stats[sub] && (rec.status === 'Present' || rec.status === 'Duty Leave')) stats[sub].present++; });
    let totalAttended = 0;
    Object.values(stats).forEach(st => totalAttended += st.present);
    const pct = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : 0;
    const presentDays = new Set(records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').map(r => (r.date || '').toString().split('T')[0]));
    const sWithPct = {};
    Object.keys(stats).forEach(sub => { const st = stats[sub]; sWithPct[sub] = { total: st.total, present: st.present, percentage: st.total > 0 ? Math.round((st.present / st.total) * 100) : 0 }; });
    res.json({ totalConducted, totalAttended, attendancePercentage: pct, daysPresent: presentDays.size, subjectStats: sWithPct });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== MANUAL ATTENDANCE (existing — 100% as-is) ==========
app.post('/api/admin/manual-attendance-bulk', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, subjects, status } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const parts = date.split('-');
    const dobj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dobj < SEMESTER_START) return res.status(400).json({ error: 'Before semester!' });
    const ds = await checkDateStatus(date);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const tr = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: tr });
    if (!user) return res.status(404).json({ error: `Roll ${tr} not registered!` });
    const actualBranch = user.branch || 'CSE';
    let marked = 0, markedSubs = [], already = [];
    const tt = getTimetableForBranch(actualBranch);
    let toMark = subjects;
    if (!toMark || toMark.length === 0) {
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = days[dobj.getDay()];
      toMark = (tt[dayName] || []).filter(e => !e.subject.includes("LIB") && !e.subject.includes("Sports")).map(e => mapToCanonical(e.subject));
    }
    const uniq = [...new Set(toMark.map(s => mapToCanonical(s)).filter(s => !s.includes('LIB') && !s.includes('Sports')))];
    for (let sub of uniq) {
      const ex = await Attendance.findOne({ rollNo: tr, subject: sub, date });
      if (ex) { already.push(sub); continue; }
      await new Attendance({ rollNo: tr, studentName: user.name, subject: sub, date, status: status || 'Present', location: null, ipAddress: 'admin-manual', isVerified: false, branch: actualBranch, markedBy: requesterRollNo }).save();
      marked++; markedSubs.push(sub);
    }
    let msg = `✅ Marked ${marked} for ${user.name} on ${date}`;
    if (already.length > 0) msg += `. Already: ${already.join(', ')}`;
    res.status(201).json({ message: msg, markedSubjects: markedSubs, alreadyMarked: already, total: marked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HISTORY / ALL (existing — 100% as-is) ==========
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const records = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ date: -1 });
    res.json(records.map(r => { r.subject = mapToCanonical(r.subject); return r; }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty';
    if (!isA && !isT) return res.status(403).json({ error: 'Access Denied' });
    let all;
    if (isT) { const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject'); all = await Attendance.find({ subject: { $in: subs } }).sort({ rollNo: 1, date: -1 }); }
    else all = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(all.map(r => { r.subject = mapToCanonical(r.subject); return r; }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== STUDENT SUMMARY (existing — 100% as-is) ==========
app.get('/api/student/summary/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const summary = await getStudentSummary(cr);
    if (!summary) return res.status(500).json({ error: 'Failed' });
    const daysAbsent = Math.max(0, summary.workingDaysSoFar - summary.daysPresent);
    res.json({ totalAcademicLectures: summary.totalAcademicLectures, totalConductedLectures: summary.totalConductedLectures, attendancePercentage: summary.attendancePercentage, daysPresent: summary.daysPresent, daysAbsent, workingDaysSoFar: summary.workingDaysSoFar, totalWorkingDaysSemester: summary.totalWorkingDaysSemester, subjectStats: summary.subjectStats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/student/bunk-advisor/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const advisor = await getBunkAdvisor(cr);
    if (!advisor) return res.status(500).json({ error: 'Failed' });
    res.json(advisor);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== EXPORT (existing — 100% as-is) ==========
app.get('/api/export/google-sheets/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const records = await Attendance.find().sort({ rollNo: 1, date: -1 });
    let csvOut = 'Roll No,Student Name,Subject,Date,Status,IP Address,Location\n';
    records.forEach(r => { const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A'; csvOut += `${r.rollNo},${r.studentName},${mapToCanonical(r.subject)},${r.date},${r.status},${r.ipAddress || 'N/A'},${loc}\n`; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.csv');
    res.send(csvOut);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/export/student-attendance/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty', isS = req1.role === 'student';
    if (!isA && !isT && !isS) return res.status(403).json({ error: 'Access Denied.' });
    const { studentRollNo, range, month } = req.query;
    if (!studentRollNo) return res.status(400).json({ error: 'studentRollNo required' });
    const cs = studentRollNo.trim().toUpperCase();
    if (isS && req1.rollNo !== cs) return res.status(403).json({ error: 'Own only.' });
    const today = new Date();
    let sD, eD;
    if (range === 'CURRENT_MONTH') { sD = new Date(today.getFullYear(), today.getMonth(), 1); eD = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else if (range === 'SELECTED_MONTH') { const m = parseInt(month); if (isNaN(m) || m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' }); sD = new Date(2026, m, 1); eD = new Date(2026, m + 1, 0); }
    else { sD = new Date(SEMESTER_START); eD = new Date(SEMESTER_END); }
    if (eD > today) eD = today;
    const startStr = getISTDateString(sD), endStr = getISTDateString(eD);
    let records = await Attendance.find({ rollNo: cs, date: { $gte: startStr, $lte: endStr } }).sort({ date: 1 });
    if (isT) { const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject'); records = records.filter(r => subs.includes(mapToCanonical(r.subject))); }
    if (records.length === 0) return res.status(404).json({ error: 'No records.' });
    const sName = records[0].studentName || 'Unknown';
    let csvOut = `Student Attendance Report\nStudent: ${sName} (${cs})\nRange: ${startStr} to ${endStr}\nGenerated: ${new Date().toLocaleString()}\n\nDate,Subject,Status,Location,IP Address\n`;
    records.forEach(r => { const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A'; csvOut += `${r.date},${mapToCanonical(r.subject)},${r.status},${loc},${r.ipAddress || 'N/A'}\n`; });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csvOut += `\nTotal: ${total}, Present: ${present}, %: ${pct}%\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cs}_${range}.csv`);
    res.send(csvOut);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== SUBJECTS / TIMETABLE (existing — 100% as-is) ==========
app.get('/api/timetable/subjects', async (req, res) => {
  try {
    const set = new Set();
    ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach(day => { CSE_TIME_TABLE[day].forEach(e => set.add(mapToCanonical(e.subject))); AIDS_TIME_TABLE[day].forEach(e => set.add(mapToCanonical(e.subject))); });
    res.json([...set].sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/timetable/full/:branch', async (req, res) => {
  try { const branch = (req.params.branch || 'CSE').toUpperCase(); res.json({ branch, timetable: getTimetableForBranch(branch), schedule: getScheduleForBranch(branch) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/timetable/strict/:branch/:date', async (req, res) => {
  try {
    const branch = (req.params.branch || 'CSE').toUpperCase();
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const ds = await checkDateStatus(date);
    res.json({ branch, date, blocked: ds.isBlocked, type: ds.type || null, dayName: ds.dayName, formatted: getStrictTimetableResponse(date, branch), schedule: ds.isBlocked ? [] : (getScheduleForDate(date, branch).schedule || []) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== CLASS REPORT (existing — 100% as-is) ==========
app.get('/api/admin/class-attendance-report', async (req, res) => {
  try {
    const { requesterRollNo, startDate, endDate, branch } = req.query;
    if (!requesterRollNo) return res.status(400).json({ error: 'requesterRollNo required' });
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const start = startDate ? new Date(startDate) : new Date(SEMESTER_START);
    let end = endDate ? new Date(endDate) : new Date(SEMESTER_END);
    const today = new Date();
    if (end > today) end = today;
    const sStr = getISTDateString(start), eStr = getISTDateString(end);
    let q = { role: 'student' };
    if (branch && branch !== 'ALL' && branch !== 'undefined' && branch !== 'null') q.branch = branch.toUpperCase();
    const students = await User.find(q).select('rollNo name branch');
    if (!students.length) return res.json({ students: [], totalLectures: 0 });
    const holidays = await Holiday.find({ date: { $gte: sStr, $lte: eStr } });
    const holidaySet = new Set(holidays.map(h => (h.date || '').toString().split('T')[0]));
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const result = await Promise.all(students.map(async s => {
      const b = s.branch || 'CSE';
      const tt = getTimetableForBranch(b);
      let totalCond = 0;
      let cur = new Date(start);
      while (cur <= end) {
        const ds = getISTDateString(cur);
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) { (tt[dayNameMap[dow]] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (!sub.includes('Sports') && !sub.includes('LIB')) totalCond++; }); }
        cur.setDate(cur.getDate() + 1);
      }
      const pc = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: sStr, $lte: eStr }, status: { $in: ['Present', 'Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      return { rollNo: s.rollNo, name: s.name, branch: b, totalPresent: pc, totalLectures: totalCond, percentage: totalCond > 0 ? Math.round((pc / totalCond) * 100) : 0 };
    }));
    result.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));
    res.json({ students: result, totalLectures: result.length > 0 ? result[0].totalLectures : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== BULK MARK/DELETE (Admin) (existing — 100% as-is) ==========
app.post('/api/admin/bulk-mark-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates, subjects } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!studentRollNos || !Array.isArray(studentRollNos) || !studentRollNos.length) return res.status(400).json({ error: 'At least 1 roll no required.' });
    if (!dates || !Array.isArray(dates) || !dates.length) return res.status(400).json({ error: 'At least 1 date required.' });
    for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: `Invalid date: ${d}` });
    const students = await User.find({ rollNo: { $in: studentRollNos }, role: 'student' });
    if (!students.length) return res.status(404).json({ error: 'No students.' });
    const results = []; let tMarked = 0, tSkipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE';
      const tt = getTimetableForBranch(b);
      let mk = 0, sk = 0;
      for (const date of dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        const dayName = ds.dayName;
        let toMark = subjects && subjects.length > 0 ? subjects : (tt[dayName] || []).map(x => mapToCanonical(x.subject));
        const uniq = [...new Set(toMark.filter(x => !x.includes('LIB') && !x.includes('Sports')))];
        for (const sub of uniq) {
          const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date });
          if (!ex) { try { await new Attendance({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: 'Present', location: null, ipAddress: 'bulk-mark', isVerified: false, branch: b, markedBy: requesterRollNo }).save(); mk++; } catch (err) { if (err.code === 11000) sk++; } }
          else sk++;
        }
      }
      results.push({ rollNo: s.rollNo, branch: b, marked: mk, skipped: sk });
      tMarked += mk; tSkipped += sk;
    }
    res.json({ message: `✅ ${tMarked} new, ${tSkipped} skipped.`, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/bulk-delete-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!studentRollNos || !studentRollNos.length) return res.status(400).json({ error: 'Roll nos required.' });
    if (!dates || !dates.length) return res.status(400).json({ error: 'Dates required.' });
    for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: `Invalid date: ${d}` });
    const r = await Attendance.deleteMany({ rollNo: { $in: studentRollNos }, date: { $in: dates } });
    res.json({ message: `✅ Deleted ${r.deletedCount}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== CHAT (existing — 100% as-is) ==========
app.get('/api/chats/:rollNo', async (req, res) => {
  try { res.json(await Chat.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ updatedAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/chats', async (req, res) => {
  try {
    const { rollNo, threadId, title, messages } = req.body;
    const cr = rollNo.trim().toUpperCase();
    if (!threadId) {
      const nc = new Chat({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: title || 'New Chat', messages: messages || [] });
      await nc.save();
      return res.status(201).json(nc);
    }
    const chat = await Chat.findOne({ threadId, rollNo: cr });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (title) chat.title = title;
    if (messages) chat.messages = messages;
    chat.updatedAt = new Date();
    await chat.save();
    res.json(chat);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/chats/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const { rollNo } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const result = await Chat.findOneAndDelete({ threadId, rollNo: rollNo.trim().toUpperCase() });
    if (!result) return res.status(404).json({ error: 'Chat not found' });
    res.json({ message: 'Chat deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/chats/clear-all', async (req, res) => {
  try {
    const { rollNo } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const r = await Chat.deleteMany({ rollNo: rollNo.trim().toUpperCase() });
    res.json({ message: `Deleted ${r.deletedCount} chat(s).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEAVE (existing — 100% as-is) ==========
app.post('/api/leave/apply', async (req, res) => {
  try {
    const { rollNo, fromDate, toDate, reason, leaveType } = req.body;
    if (!rollNo || !fromDate || !toDate || !reason) return res.status(400).json({ error: 'All fields required.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    if (new Date(toDate) < new Date(fromDate)) return res.status(400).json({ error: 'End before start.' });
    const leave = await new Leave({ rollNo: cr, studentName: user.name, fromDate, toDate, reason, leaveType: leaveType || 'Personal', branch: user.branch || 'CSE' });
    await leave.save();
    sendPushToRole('admin', '📋 New Leave Request', `${user.name} (${cr}) — ${fromDate} to ${toDate}`, { type: 'leave' }).catch(() => {});
    res.status(201).json({ message: '✅ Submitted!', leave });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/leave/my/:rollNo', async (req, res) => {
  try { res.json(await Leave.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/leave/requests/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await Leave.find().sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/leave/action/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, adminNote } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ error: 'Not found!' });
    leave.status = action; leave.reviewedBy = req1.rollNo; leave.adminNote = adminNote || '';
    await leave.save();
    if (action === 'Approved') {
      const student = await User.findOne({ rollNo: leave.rollNo });
      const b = student?.branch || 'CSE';
      let cur = new Date(leave.fromDate);
      const end = new Date(leave.toDate);
      while (cur <= end) {
        const ds = getISTDateString(cur);
        const dsStatus = await checkDateStatus(ds);
        if (!dsStatus.isBlocked) {
          const tt = getTimetableForBranch(b)[dsStatus.dayName] || [];
          for (const entry of tt) {
            const sub = mapToCanonical(entry.subject);
            if (sub.includes('LIB') || sub.includes('Sports')) continue;
            const ex = await Attendance.findOne({ rollNo: leave.rollNo, subject: sub, date: ds });
            if (!ex) await new Attendance({ rollNo: leave.rollNo, studentName: leave.studentName, subject: sub, date: ds, status: 'Duty Leave', isVerified: false, branch: b, ipAddress: 'leave-approved' }).save();
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    sendPushToRollNo(leave.rollNo, action === 'Approved' ? '✅ Leave Approved' : '❌ Leave Rejected', `${leave.fromDate} → ${leave.toDate}${adminNote ? ' — ' + adminNote : ''}`, { type: 'leave_review' }).catch(() => {});
    res.json({ message: `✅ Leave ${action.toLowerCase()} for ${leave.studentName}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/clear-leaves', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = await Leave.deleteMany({});
    res.json({ message: `Deleted ${r.deletedCount} leave request(s).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DEFAULTERS (existing — 100% as-is) ==========
app.get('/api/admin/defaulters/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const threshold = parseInt(req.query.threshold) || 75;
    const branchFilter = (req.query.branch || '').toUpperCase();
    let studentQuery = { role: 'student' };
    if (branchFilter && branchFilter !== 'ALL') studentQuery.branch = branchFilter;
    const students = await User.find(studentQuery).select('rollNo name branch').sort({ rollNo: 1 }).lean();
    console.log(`📊 [DEFAULTERS] Scanning ${students.length} students | threshold=${threshold}%`);
    const defaulters = []; const errors = [];
    const buckets = { zero: 0, low: 0, mid: 0 };
    for (const s of students) {
      try {
        const summary = await getStudentSummary(s.rollNo);
        if (!summary) { errors.push({ rollNo: s.rollNo, reason: 'no-summary' }); continue; }
        const pct = summary.attendancePercentage || 0;
        const total = summary.totalConductedLectures || 0;
        const present = summary.totalAcademicLectures || 0;
        if (pct < threshold) {
          defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total, noData: total === 0 });
          if (pct === 0) buckets.zero++; else if (pct < 50) buckets.low++; else buckets.mid++;
        }
      } catch (e) { errors.push({ rollNo: s.rollNo, reason: e.message }); }
    }
    defaulters.sort((a, b) => a.pct - b.pct);
    res.json({ threshold, branch: branchFilter || 'ALL', totalStudents: students.length, totalDefaulters: defaulters.length, buckets, scanned: students.length - errors.length, errors: errors.length ? errors : undefined, defaulters });
  } catch (err) { console.error('Defaulters error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  HELPERS (existing — 100% as-is)
// ============================================================
async function getSystemHealth() {
  const uptime = Date.now() - SERVER_START_TIME;
  const uptimeHrs = (uptime / (1000 * 60 * 60)).toFixed(2);
  const dbState = ['Disconnected', 'Connected', 'Connecting', 'Disconnecting'][mongoose.connection.readyState] || 'Unknown';
  let dbPing = 'N/A';
  try { const pingStart = Date.now(); await mongoose.connection.db.admin().ping(); dbPing = (Date.now() - pingStart) + 'ms'; } catch (e) { dbPing = 'Failed'; }
  const [users, students, faculty, attendances, requests, holidays, chats, regReqs] = await Promise.all([
    User.countDocuments().catch(() => 0), User.countDocuments({ role: 'student' }).catch(() => 0), User.countDocuments({ role: 'faculty' }).catch(() => 0),
    Attendance.countDocuments().catch(() => 0), AttendanceRequest.countDocuments({ status: 'Pending' }).catch(() => 0), Holiday.countDocuments().catch(() => 0),
    Chat.countDocuments().catch(() => 0), RegistrationRequest.countDocuments({ status: 'Pending' }).catch(() => 0)
  ]);
  return { status: 'HEALTHY', uptime: `${uptimeHrs} hours`, database: { state: dbState, ping: dbPing }, ai: { primary: { provider: 'Groq', model: GROQ_MODEL, keysConfigured: GROQ_API_KEYS.length }, fallback: { provider: 'Gemini', model: GEMINI_MODEL, keysConfigured: GEMINI_API_KEYS.length, discovered: _geminiModelsCache.list.length } }, fcm: { ready: fcmReady }, counts: { totalUsers: users, students, faculty, attendances, pendingRequests: requests, holidays, chats, pendingRegistrationRequests: regReqs } };
}

async function getFacultyClassAverage(teacherRollNo, subjectFilter = null) {
  const teacher = await User.findOne({ rollNo: teacherRollNo.toUpperCase(), role: 'faculty' });
  if (!teacher) return { error: 'Faculty not found' };
  let subjects = await TeacherSubject.find({ teacherRollNo: teacherRollNo.toUpperCase() }).distinct('subject');
  if (subjectFilter) { const canon = mapToCanonical(subjectFilter); subjects = subjects.filter(s => s === canon); if (!subjects.length) return { error: `You don't teach ${subjectFilter}` }; }
  if (!subjects.length) return { error: 'No subjects assigned' };
  const allRecords = await Attendance.find({ subject: { $in: subjects } });
  const present = allRecords.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
  const total = allRecords.length;
  const avg = total > 0 ? Math.round((present / total) * 100) : 0;
  const subjWise = {};
  subjects.forEach(s => { subjWise[s] = { present: 0, total: 0 }; });
  allRecords.forEach(r => { const s = mapToCanonical(r.subject); if (subjWise[s]) { subjWise[s].total++; if (r.status === 'Present' || r.status === 'Duty Leave') subjWise[s].present++; } });
  Object.keys(subjWise).forEach(s => { subjWise[s].percentage = subjWise[s].total > 0 ? Math.round((subjWise[s].present / subjWise[s].total) * 100) : 0; });
  const studentRolls = await Attendance.find({ subject: { $in: subjects } }).distinct('rollNo');
  return { teacher: teacher.name, teacherRollNo, subjects, totalStudents: studentRolls.length, overallAverage: avg, totalRecords: total, presentRecords: present, subjectWise: subjWise };
}

async function getStudentLookup(targetRollNo, requesterRollNo, requesterRole) {
  const target = await User.findOne({ rollNo: targetRollNo.toUpperCase(), role: 'student' });
  if (!target) return { error: `Student ${targetRollNo} not found` };
  const summary = await getStudentSummary(targetRollNo);
  if (!summary) return { error: 'Could not compute' };
  let recentRecords = await Attendance.find({ rollNo: targetRollNo.toUpperCase() }).sort({ date: -1 }).limit(15).lean();
  if (requesterRole === 'faculty') { const subs = await TeacherSubject.find({ teacherRollNo: requesterRollNo.toUpperCase() }).distinct('subject'); recentRecords = recentRecords.filter(r => subs.includes(mapToCanonical(r.subject))); }
  return { student: { rollNo: target.rollNo, name: target.name, branch: target.branch, semester: target.semester }, overall: { percentage: summary.attendancePercentage, attended: summary.totalAcademicLectures, conducted: summary.totalConductedLectures, daysPresent: summary.daysPresent, workingDaysSoFar: summary.workingDaysSoFar }, subjectStats: summary.subjectStats, recentRecords: recentRecords.map(r => ({ date: r.date, subject: mapToCanonical(r.subject), status: r.status })) };
}

function parseBulkMarkingIntent(message) {
  const lower = message.toLowerCase();
  let branch = null;
  if (/\baids\b/i.test(lower)) branch = 'AIDS'; else if (/\bcse\b/i.test(lower)) branch = 'CSE';
  let status = 'Present';
  if (/\babsent\b/i.test(lower)) status = 'Absent'; else if (/duty\s*leave/i.test(lower)) status = 'Duty Leave';
  const rangePatterns = [/(?:roll|roll\s*no|number)?\s*(\d{1,3})\s*(?:se|to|through|-|–)\s*(\d{1,3})/i, /(\d{1,3})\s*[-–]\s*(\d{1,3})/i];
  let startNum = null, endNum = null;
  for (const pat of rangePatterns) { const m = message.match(pat); if (m) { startNum = parseInt(m[1]); endNum = parseInt(m[2]); break; } }
  const explicitRolls = [];
  const rollRegex = /2[45](CSE|AIDS)\d{2}/gi;
  let match;
  while ((match = rollRegex.exec(message)) !== null) explicitRolls.push(match[0].toUpperCase());
  let date = null;
  const today = getISTDateString(new Date());
  const tomorrow = getISTDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const dateMatch = message.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) date = dateMatch[1];
  else if (/\btomorrow|kal\b/i.test(lower)) date = tomorrow;
  else if (/\btoday|aaj\b/i.test(lower)) date = today;
  let rolls = [...explicitRolls];
  if (startNum !== null && endNum !== null && branch) { const prefix = branch === 'CSE' ? '24CSE' : '24AIDS'; for (let i = startNum; i <= endNum; i++) rolls.push(`${prefix}${String(i).padStart(2, '0')}`); }
  rolls = [...new Set(rolls)];
  return { canParse: rolls.length > 0, rolls, branch: branch || 'CSE', status, date: date || today, confidence: rolls.length > 0 ? 'high' : 'low' };
}

async function getPendingRequestsSummary() {
  const attendancePending = await AttendanceRequest.countDocuments({ status: 'Pending' });
  const attendanceApproved = await AttendanceRequest.countDocuments({ status: 'Approved' });
  const attendanceRejected = await AttendanceRequest.countDocuments({ status: 'Rejected' });
  const accountPending = await AccountRequest.countDocuments({ status: 'Pending' });
  const accountApproved = await AccountRequest.countDocuments({ status: 'Approved' });
  const forgotPending = await AccountRequest.countDocuments({ type: 'forgot_password', status: 'Pending' });
  const devicePending = await AccountRequest.countDocuments({ type: 'device_reset', status: 'Pending' });
  const leavesPending = await Leave.countDocuments({ status: 'Pending' });
  const registrationsPending = await RegistrationRequest.countDocuments({ status: 'Pending' });
  return { attendance: { pending: attendancePending, approved: attendanceApproved, rejected: attendanceRejected }, accountRequests: { pending: accountPending, approved: accountApproved, forgotPassword: forgotPending, deviceReset: devicePending }, leaves: { pending: leavesPending }, registration: { pending: registrationsPending } };
}

async function getPasscodeSystemStatus() {
  const total = await Passcode.countDocuments({});
  const enabledCount = await Passcode.countDocuments({ enabled: true });
  const activePublic = await Passcode.find({ published: true, enabled: true, isPublic: true, expiresAt: { $gt: new Date() } }).select('type passcode expiresAt publishedAt durationMinutes').lean();
  const todayPasscodes = await Passcode.find({ expiresAt: { $gt: new Date() } }).select('type passcode expiresAt published enabled').lean();
  return { systemEnabled: enabledCount > 0 || total === 0, totalPasscodes: total, enabledCount, activePublishedPublic: activePublic.map(p => ({ type: p.type, passcode: p.passcode, expiresIn: Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60000) + ' min', publishedAt: p.publishedAt, durationMinutes: p.durationMinutes })), todayCount: todayPasscodes.length };
}

async function getImpersonationData(targetRollNo) {
  const target = await User.findOne({ rollNo: targetRollNo.toUpperCase() });
  if (!target) return { error: `User ${targetRollNo} not found` };
  if (target.role !== 'student') return { error: `Only students can be impersonated. Target is ${target.role}.` };
  const summary = await getStudentSummary(targetRollNo);
  const advisor = await getBunkAdvisor(targetRollNo);
  const recentRecords = await Attendance.find({ rollNo: targetRollNo.toUpperCase() }).sort({ date: -1 }).limit(10).lean();
  const requests = await AttendanceRequest.find({ rollNo: targetRollNo.toUpperCase() }).sort({ createdAt: -1 }).limit(5).lean();
  return { student: { rollNo: target.rollNo, name: target.name, branch: target.branch, semester: target.semester, deviceBound: !!target.boundDeviceId, lastAttendance: target.lastAttendanceTime }, summary: summary ? { percentage: summary.attendancePercentage, attended: summary.totalAcademicLectures, conducted: summary.totalConductedLectures, daysPresent: summary.daysPresent, workingDaysSoFar: summary.workingDaysSoFar, subjectStats: summary.subjectStats } : null, advisor: advisor ? { status: advisor.status, canBunkLectures: advisor.canBunkLectures, lecturesNeeded: advisor.lecturesNeeded, message: advisor.message } : null, recentRecords: recentRecords.map(r => ({ date: r.date, subject: mapToCanonical(r.subject), status: r.status })), recentRequests: requests.map(r => ({ date: r.date, type: r.lectureType, status: r.status })) };
}

async function getGeofenceGuide(userContext) {
  const now = new Date();
  const todayStr = getISTDateString(now);
  const istHour = getISTHour(now);
  const istMin = getISTMinutes(now);
  const user = await User.findOne({ rollNo: userContext.rollNo });
  if (!user) return { error: 'User not found' };
  const branch = user.branch || 'CSE';
  const ds = await checkDateStatus(todayStr);
  const period = getCurrentPeriod(branch);
  const activePasscodes = await Passcode.find({ enabled: true, expiresAt: { $gt: now } }).select('type passcode expiresAt published isPublic').lean();
  const todayRecords = await Attendance.find({ rollNo: user.rollNo, date: todayStr });
  const publicFD = activePasscodes.find(p => p.type === 'full_day' && p.published && p.isPublic);
  const publicSL = activePasscodes.find(p => p.type === 'single_lecture' && p.published && p.isPublic);
  return { currentTime: `${String(Math.floor(istMin/60)).padStart(2,'0')}:${String(istMin%60).padStart(2,'0')} IST`, todayStatus: ds.isBlocked ? `${ds.type === 'WEEKEND' ? 'Weekend' : 'Holiday'} — Closed` : 'College open', activePeriod: period ? `${period.start}–${period.end} · ${mapToCanonical(period.subject)} (${period.faculty})` : 'No active lecture', collegeHours: '09:20 AM – 03:00 PM', attendanceWindow: { liveMarking: istHour < COLLEGE_CLOSE_HOUR ? '✅ Available until 3 PM' : '❌ Closed (after 3 PM)', requestWindow: istHour >= COLLEGE_CLOSE_HOUR ? '✅ Request available' : `⏰ Opens after 3 PM` }, publishedPasscodes: { fullDay: publicFD ? { passcode: publicFD.passcode, expiresIn: Math.round((new Date(publicFD.expiresAt).getTime() - Date.now()) / 60000) + ' min' } : 'None active', singleLecture: publicSL ? { passcode: publicSL.passcode, expiresIn: Math.round((new Date(publicSL.expiresAt).getTime() - Date.now()) / 60000) + ' min' } : 'None active' }, todayMarked: todayRecords.length, todaySubjects: todayRecords.map(r => `${mapToCanonical(r.subject)} — ${r.status}`), geofence: { centerLat: COLLEGE_LAT, centerLng: COLLEGE_LNG, radiusMeters: COLLEGE_RADIUS } };
}

async function getTopAttendance(limit = 5) {
  const students = await User.find({ role: 'student' }).select('rollNo name branch');
  const today = getISTDateString(new Date());
  const startStr = getISTDateString(SEMESTER_START);
  const results = [];
  for (const s of students) {
    const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
    const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
    if (total > 0) results.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, present, total, pct: Math.round((present/total)*100) });
  }
  results.sort((a,b) => b.pct - a.pct || b.present - a.present);
  return results.slice(0, limit);
}

// ============================================================
//  FAST REGEX INTENT PARSER (existing — 100% as-is)
// ============================================================
function fastIntentParse(message, role) {
  if (!message) return null;
  const t = message.toLowerCase().trim();
  if (role === 'student') {
    if (/^(mark|lagao|lag|lagado|lagwa|dikhao|kar).{0,20}(my|meri|aaj|today|abhi).{0,10}(attendance|hazri|haziri|present|upasthiti)/i.test(t) || /(meri|my|aaj ki|today).{0,15}(attendance|hazri|haziri|present).{0,15}(mark|lagao|lag|kar|lagado)/i.test(t) || /^mark (my )?attendance$/i.test(t) || /^attendance mark kar(o|do)?$/i.test(t)) {
      const isLecture = /(single|ek|one|lecture|period|class)/i.test(t) && !/full|pura|poora/i.test(t);
      return { action: 'db_live_mark', data: { lectureType: isLecture ? 'single_lecture' : 'full_day' }, explanation: 'Starting attendance marking flow', _fast: true };
    }
    if (/(meri|my|show|dikhao).{0,20}(attendance|hazri|haziri|percentage|summary)/i.test(t) || /^(attendance|hazri)( kya hai| kitni hai)?$/i.test(t)) return { action: 'db_my_attendance', explanation: 'Your attendance summary', _fast: true };
    if (/(my|meri|mere|show|dikhao).{0,15}(requests?|aavedan)/i.test(t)) return { action: 'db_my_requests', explanation: 'Your requests', _fast: true };
    if (/(bunk|chhutti\s*le|skip).{0,15}(kitni|how many|sakta|skata)/i.test(t) || /(kitni|how many).{0,10}bunk/i.test(t)) return { action: 'db_bunk_advisor', explanation: 'Bunk advisor', _fast: true };
  }
  if (role === 'admin' || role === 'faculty') {
    const deviceResetMatch = t.match(/(?:reset|unlock|clear)\s+(?:device\s+)?(?:of\s+|for\s+)?(2[45](?:cse|aids)\d{2})/i);
    if (deviceResetMatch) return { action: 'db_reset_device', data: { rollNo: deviceResetMatch[1].toUpperCase() }, explanation: 'Device reset', _fast: true };
    const pwdResetMatch = t.match(/(?:reset|change)\s+password\s+(?:of\s+|for\s+)?(2[45](?:cse|aids)\d{2})\s+(?:to\s+)?(\S+)/i);
    if (pwdResetMatch) return { action: 'db_reset_password', data: { rollNo: pwdResetMatch[1].toUpperCase(), newPassword: pwdResetMatch[2] }, explanation: 'Password reset', _fast: true };
    const delMatch = t.match(/(?:delete|remove|hatao)\s+(?:user\s+|account\s+)?(2[45](?:cse|aids)\d{2})/i);
    if (delMatch) return { action: 'db_delete_user', data: { rollNo: delMatch[1].toUpperCase() }, explanation: `Delete ${delMatch[1]}`, requiresConfirmation: true, _fast: true };
    if (/(defaulters?|below\s*75|kam\s*attendance|low\s*attendance|defaulter\s*list)/i.test(t)) { const thresh = t.match(/(\d{2,3})\s*%?/); return { action: 'db_defaulters', data: { threshold: thresh ? parseInt(thresh[1]) : 75 }, explanation: 'Defaulters list', _fast: true }; }
    if (/(approve|manzoor|swikar).{0,15}(all|pending|sab)/i.test(t)) return { action: 'db_bulk_review', data: { decision: 'Approved' }, explanation: 'Approve all pending', _fast: true };
    if (/(reject).{0,15}(all|pending|sab)/i.test(t)) return { action: 'db_bulk_review', data: { decision: 'Rejected' }, explanation: 'Reject all pending', _fast: true };
    if (/(pending|list|show|dikhao).{0,15}requests?/i.test(t)) return { action: 'db_list_requests', data: { status: 'Pending' }, explanation: 'List requests', _fast: true };
    if (/(pending|list|show|dikhao).{0,15}registration/i.test(t)) return { action: 'db_list_registrations', data: { status: 'Pending' }, explanation: 'List registrations', _fast: true };
    if (/(dashboard|stats|summary|overall)/i.test(t) && t.length < 40) return { action: 'db_dashboard_stats', explanation: 'Dashboard stats', _fast: true };
  }
  if (/(timetable|time\s*table|schedule|classes).{0,15}(today|aaj|dikhao|show)?/i.test(t)) return { action: 'db_timetable', explanation: 'Timetable', _fast: true };
  return null;
}

const DB_INTENT_PROMPT = `You are a JSON API. Return ONLY valid JSON. No prose. No markdown.
Translate user's natural language into a JSON action. NEVER invent data. NEVER write prose.
## Response format (STRICT):
{"action":"...","collection":"...","filter":{...},"update":{...},"data":{...},"limit":number,"sort":{...},"explanation":"...","requiresConfirmation":true|false,"reply":null}
## SUPPORTED ACTIONS:
### GENERAL
- "reply" → casual chat (put answer in "reply")
- "db_read" / "db_count" → read/count
- "db_timetable" → timetable
- "db_system_health" → health (ADMIN)
### STUDENT
- "db_live_mark" → live mark (data: { lectureType })
- "db_submit_request" / "db_my_requests" / "db_my_attendance" / "db_my_leave" / "db_apply_leave"
- "db_bunk_advisor" / "db_working_days" / "db_geofence_guide"
### FACULTY
- "db_faculty_mark" / "db_nlp_bulk_mark" / "db_generate_passcode" / "db_my_students"
- "db_recent_marks" / "db_class_average" / "db_student_lookup" / "db_review_request"
### ADMIN
- "db_add_user" / "db_delete_user" / "db_reset_password" / "db_reset_device" / "db_update_roll"
- "db_broadcast_notice" / "db_clear_notice" / "db_add_holiday" / "db_delete_holiday"
- "db_publish_passcode" / "db_toggle_passcode" / "db_passcode_status"
- "db_list_requests" / "db_bulk_review" / "db_clear_requests"
- "db_list_registrations" / "db_review_registration" / "db_clear_registrations"
- "db_list_account_requests" / "db_review_account_request" / "db_clear_account_requests"
- "db_list_leave" / "db_review_leave" / "db_clear_leaves"
- "db_manual_mark" / "db_bulk_mark" / "db_bulk_delete" / "db_top_attendance"
- "db_defaulters" / "db_impersonate" / "db_fix_attendance"
- "db_assign_subject" / "db_remove_subject" / "db_clear_chats" / "db_dashboard_stats" / "db_all_users"
## CRITICAL:
1. Students CANNOT create attendances. Use "db_live_mark" or "db_submit_request".
2. "mark my attendance" → action="db_live_mark", data={lectureType: 'full_day'}
3. Destructive → requiresConfirmation: true
4. If you cannot match → action "reply"
5. Return ONLY JSON, no extra text`;

async function detectDbIntent(message, userContext, threadId = null) {
  const fastIntent = fastIntentParse(message, userContext.role);
  if (fastIntent) { console.log(`⚡ [FAST-INTENT] ${fastIntent.action}`); return fastIntent; }
  const today = getISTDateString(new Date());
  const tomorrow = getISTDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const now = new Date();
  const istMin = getISTMinutes(now);
  const istTimeStr = `${String(Math.floor(istMin/60)).padStart(2,'0')}:${String(istMin%60).padStart(2,'0')}`;
  const ctx = `Role: ${userContext.role}\nRollNo: ${userContext.rollNo}\nName: ${userContext.name}\nBranch: ${userContext.branch || 'CSE'}\nToday: ${today}\nTomorrow: ${tomorrow}\nCurrent IST: ${istTimeStr}\nCollege Hours: 09:20–15:00 IST`;
  const prompt = `${ctx}\n\nUser message: "${message}"\n\nReturn ONLY valid JSON.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await callAI({ prompt, systemPrompt: DB_INTENT_PROMPT, maxTokens: 800, temperature: 0.1, threadId, forceJson: true });
      let cleaned = reply.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleaned = jsonMatch[0];
      return JSON.parse(cleaned);
    } catch (err) { if (attempt === 1) return { action: 'reply', reply: null, explanation: 'Could not parse', requiresConfirmation: false }; }
  }
  return { action: 'reply', reply: null };
}

// ============================================================
//  DB ACTION EXECUTOR (existing — 100% as-is)
// ============================================================
async function executeDbAction(intent, userContext, threadId = null) {
  const { action, collection, filter, update, data, limit, sort, explanation, reply } = intent;
  const isAdmin = userContext.role === 'admin';
  const isFaculty = userContext.role === 'faculty';
  const isStudent = userContext.role === 'student';
  let f = filter ? { ...filter } : null;
  const collMap = { users: User, attendances: Attendance, holidays: Holiday, notices: Notice, leaves: Leave, passcodes: Passcode, teachersubjects: TeacherSubject, attendancerequests: AttendanceRequest, registrationrequests: RegistrationRequest, accountrequests: AccountRequest };

  if (action === 'reply') return { reply: reply || explanation || 'Noted.', isReply: true };

  if (action === 'db_live_mark') { if (!isStudent) return { error: 'Only students can mark attendance.' }; return { needsLiveMarking: true, data: data || {}, message: 'Share location and passcode.' }; }

  if (action === 'db_submit_request') {
    if (!isStudent) return { error: 'Only students.' };
    const rd = data || {};
    const todayStr = getISTDateString(new Date());
    const reqDate = rd.date || todayStr;
    const lectureType = rd.lectureType || 'full_day';
    if (reqDate > todayStr) return { error: '🚫 Future date not allowed.' };
    if (reqDate === todayStr && getISTHour(new Date()) < COLLEGE_CLOSE_HOUR) return { error: '⏰ Today\'s request only after 3 PM.' };
    const ds = await checkDateStatus(reqDate);
    if (ds.isBlocked) return { error: ds.type === 'WEEKEND' ? `${ds.dayName}: Closed.` : `Holiday.` };
    const dup = await AttendanceRequest.findOne({ rollNo: userContext.rollNo, date: reqDate, lectureType, status: 'Pending' });
    if (dup) return { error: 'Already pending.' };
    await AttendanceRequest.create({ rollNo: userContext.rollNo, studentName: userContext.name, branch: userContext.branch, date: reqDate, lectureType, subject: rd.subject ? mapToCanonical(rd.subject) : null, reason: rd.reason || 'From chat', location: null, distanceFromCollege: null, locationVerified: false, isPastDate: reqDate < todayStr, status: 'Pending' });
    sendPushToRole('admin', '📩 New Attendance Request', `${userContext.name} (${userContext.rollNo}) — ${reqDate}`, { type: 'attendance_request' }).catch(() => {});
    return { reply: `✅ **Request submitted!**\n\n• Date: ${reqDate}\n• Type: ${lectureType.replace('_',' ')}\n• Status: Pending admin review`, isReply: true, requestSubmitted: true };
  }
  if (action === 'db_my_requests') {
    if (!isStudent) return { error: 'Student only.' };
    const reqs = await AttendanceRequest.find({ rollNo: userContext.rollNo }).sort({ createdAt: -1 }).limit(15).lean();
    if (!reqs.length) return { reply: 'You have no attendance requests.', isReply: true };
    return { reply: `📋 **Your Recent Requests**\n\n` + reqs.map(r => `• ${r.date} — ${r.lectureType.replace('_',' ')}${r.subject ? ' (' + r.subject + ')' : ''} → **${r.status}**`).join('\n'), isReply: true };
  }
  if (action === 'db_my_attendance') {
    if (!isStudent) return { error: 'Student only.' };
    const summary = await getStudentSummary(userContext.rollNo);
    if (!summary) return { error: 'No data.' };
    const advisor = await getBunkAdvisor(userContext.rollNo);
    let txt = `📊 **Your Attendance Summary**\n\n• Working Days: **${summary.workingDaysSoFar}**\n• Days Present: **${summary.daysPresent}**\n• Lectures: **${summary.totalAcademicLectures}/${summary.totalConductedLectures}**\n• Percentage: **${summary.attendancePercentage}%**\n\n`;
    if (advisor) txt += advisor.status === 'SAFE' ? `✅ Safe. You can skip ~**${advisor.canBunkLectures}** lecture(s).` : `⚠️ Need **${advisor.lecturesNeeded}** more lecture(s) to reach 75%.`;
    return { reply: txt, isReply: true };
  }
  if (action === 'db_my_leave') {
    if (!isStudent) return { error: 'Student only.' };
    const leaves = await Leave.find({ rollNo: userContext.rollNo }).sort({ createdAt: -1 }).limit(15).lean();
    if (!leaves.length) return { reply: 'You have no leave applications.', isReply: true };
    return { reply: `📋 **Your Leaves**\n\n` + leaves.map(l => `• ${l.fromDate} → ${l.toDate} — ${l.status}`).join('\n'), isReply: true };
  }
  if (action === 'db_apply_leave') {
    if (!isStudent) return { error: 'Student only.' };
    const d = data || {};
    if (!d.fromDate || !d.toDate) return { error: 'Dates required.' };
    await Leave.create({ rollNo: userContext.rollNo, studentName: userContext.name, fromDate: d.fromDate, toDate: d.toDate, reason: d.reason || 'Personal', leaveType: d.leaveType || 'Personal', branch: userContext.branch });
    return { reply: `✅ Leave applied: **${d.fromDate}** → **${d.toDate}**\nAdmin will review soon.`, isReply: true };
  }
  if (action === 'db_working_days') {
    const today = getISTDateString(new Date());
    const wd = await getWorkingDays(SEMESTER_START, new Date());
    const twd = await getWorkingDays(SEMESTER_START, SEMESTER_END);
    const holidays = await Holiday.find({ date: { $gte: today } }).sort({ date: 1 }).limit(10).lean();
    let txt = `📆 **Working Days**\n\n• So far: **${wd}**\n• Full semester: **${twd}**`;
    if (holidays.length) txt += `\n\n**Upcoming Holidays:**\n` + holidays.map(h => `• ${h.date} — ${h.reason}`).join('\n');
    return { reply: txt, isReply: true };
  }
  if (action === 'db_my_report_pdf') return { reply: `📄 I can generate your PDF. Tap **Download PDF** on dashboard or say the exact month.`, isReply: true, showDownload: true };

  if (action === 'db_faculty_mark') {
    if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
    const d = data || {};
    if (!d.rollNo || !d.subject) return { error: 'rollNo and subject required.' };
    const subj = mapToCanonical(d.subject);
    if (isFaculty && !(await TeacherSubject.findOne({ teacherRollNo: userContext.rollNo, subject: subj }))) return { error: `You don't teach ${d.subject}.` };
    const date = d.date || getISTDateString(new Date());
    const ds = await checkDateStatus(date);
    if (ds.isBlocked) return { error: `${date} is blocked (${ds.type}).` };
    const stu = await User.findOne({ rollNo: d.rollNo.toUpperCase(), role: 'student' });
    if (!stu) return { error: `Student ${d.rollNo} not found.` };
    try {
      const existing = await Attendance.findOne({ rollNo: stu.rollNo, subject: subj, date });
      if (existing) return { error: `Already marked for ${d.rollNo} on ${date}.` };
      await Attendance.create({ rollNo: stu.rollNo, studentName: stu.name, subject: subj, date, status: 'Present', location: null, ipAddress: 'chat-faculty-mark', isVerified: false, branch: stu.branch || 'CSE' });
      return { reply: `✅ Marked **${stu.rollNo}** (${stu.name}) as **Present** for **${subj}** on ${date}.`, isReply: true };
    } catch (e) { return { error: e.message }; }
  }
  if (action === 'db_nlp_bulk_mark') {
    if (!isFaculty) return { error: 'Faculty only.' };
    const raw = data?.rawMessage || '';
    const parsed = parseBulkMarkingIntent(raw);
    if (!parsed.canParse) return { error: 'Could not detect roll numbers.', needsClarification: true };
    const dsC = await checkDateStatus(parsed.date);
    if (dsC.isBlocked) return { error: `Date ${parsed.date} blocked (${dsC.type}).` };
    const subjects = await TeacherSubject.find({ teacherRollNo: userContext.rollNo.toUpperCase() }).distinct('subject');
    if (!subjects.length) return { error: 'No subjects assigned.' };
    const students = await User.find({ rollNo: { $in: parsed.rolls }, role: 'student' });
    if (!students.length) return { error: `No matching students.` };
    let totalMarked = 0, totalSkipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE';
      const daySubjects = (getTimetableForBranch(b)[dsC.dayName] || []).map(mapToCanonical).filter(x => subjects.includes(x));
      const uniq = [...new Set(daySubjects.filter(x => !x.includes('LIB') && !x.includes('Sports')))];
      for (const sub of uniq) {
        try { const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date: parsed.date }); if (!ex) { await Attendance.create({ rollNo: s.rollNo, studentName: s.name, subject: sub, date: parsed.date, status: parsed.status, location: null, ipAddress: 'nlp-bulk', isVerified: false, branch: b }); totalMarked++; } else totalSkipped++; }
        catch (e) { if (e.code === 11000) totalSkipped++; }
      }
    }
    return { reply: `✅ **Bulk Marked**\n\n• Date: ${parsed.date}\n• Status: ${parsed.status}\n• Students: **${students.length}**\n• New: **${totalMarked}**\n• Skipped: ${totalSkipped}`, isReply: true };
  }
  if (action === 'db_faculty_bulk_delete') {
    if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
    const d = data || {};
    if (!d.studentRollNos?.length || !d.dates?.length) return { error: 'studentRollNos and dates required.' };
    let q = { rollNo: { $in: d.studentRollNos }, date: { $in: d.dates } };
    if (isFaculty) { const subs = await TeacherSubject.find({ teacherRollNo: userContext.rollNo }).distinct('subject'); q.subject = { $in: subs }; }
    const r = await Attendance.deleteMany(q);
    return { reply: `✅ Deleted **${r.deletedCount}** record(s).`, isReply: true };
  }
  if (action === 'db_generate_passcode') {
    if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
    const todayStr = getISTDateString(new Date());
    const ds = await checkDateStatus(todayStr);
    if (ds.isBlocked) return { error: 'College closed.' };
    const period = getCurrentPeriod(userContext.branch || 'CSE');
    if (!period) return { error: 'No active lecture.' };
    const passcode = Math.floor(1000 + Math.random() * 9000).toString();
    const now = new Date();
    const expiry = new Date(now.getTime() + 5 * 60 * 1000);
    const key = `single_lecture_${todayStr}_${period.start}`;
    await Passcode.deleteMany({ key });
    await new Passcode({ passcode, type: 'single_lecture', key, expiresAt: expiry, published: true, isPublic: true, enabled: true, publishedAt: now, publishedBy: userContext.rollNo, durationMinutes: 5 }).save();
    sendPushToAllStudents('🔐 Lecture Passcode Published', `Passcode: ${passcode} — valid 5 min`, { type: 'passcode' }).catch(() => {});
    return { reply: `🔐 **Lecture Passcode Generated:**\n\n**${passcode}**\n\n• Valid for 5 min\n• For: ${mapToCanonical(period.subject)}`, isReply: true };
  }
  if (action === 'db_my_students') {
    if (!isFaculty) return { error: 'Faculty only.' };
    const subjects = await TeacherSubject.find({ teacherRollNo: userContext.rollNo }).distinct('subject');
    if (!subjects.length) return { reply: 'No subjects assigned to you.', isReply: true };
    const records = await Attendance.find({ subject: { $in: subjects } }).distinct('rollNo');
    const students = await User.find({ rollNo: { $in: records }, role: 'student' }).select('name rollNo').sort({ rollNo: 1 });
    if (!students.length) return { reply: 'No students found in your subjects yet.', isReply: true };
    return { reply: `👥 **Your Students (${students.length})**\n\n` + students.slice(0, 40).map(s => `• ${s.rollNo} — ${s.name}`).join('\n'), isReply: true };
  }
  if (action === 'db_recent_marks') {
    if (!isFaculty) return { error: 'Faculty only.' };
    const recs = await Attendance.find({ markedBy: userContext.rollNo }).sort({ createdAt: -1 }).limit(15).lean();
    if (!recs.length) return { reply: 'No recent marks.', isReply: true };
    return { reply: `📝 **Recent Marks**\n\n` + recs.map(r => `• ${r.date} — ${r.rollNo} — ${mapToCanonical(r.subject)}`).join('\n'), isReply: true };
  }
  if (action === 'db_class_average') {
    if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
    const avg = await getFacultyClassAverage(userContext.rollNo, data?.subject || null);
    if (avg.error) return { error: avg.error };
    const subjLines = Object.entries(avg.subjectWise || {}).map(([s, st]) => `• ${s}: **${st.percentage}%** (${st.present}/${st.total})`).join('\n');
    return { reply: `👨‍🏫 **Class Average**\n\n**Students:** ${avg.totalStudents}\n**Average:** **${avg.overallAverage}%**\n\n${subjLines}`, isReply: true };
  }
  if (action === 'db_student_lookup') {
    if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
    if (!data?.rollNo) return { error: 'rollNo required.' };
    const lookup = await getStudentLookup(data.rollNo, userContext.rollNo, userContext.role);
    if (lookup.error) return { error: lookup.error };
    const s = lookup.student; const o = lookup.overall;
    let txt = `🎓 **${s.name}** (${s.rollNo}) — ${s.branch}\n\n• Overall: **${o.attended}/${o.conducted}** (${o.percentage}%)\n• Days: ${o.daysPresent}/${o.workingDaysSoFar}`;
    return { reply: txt, isReply: true };
  }
  if (action === 'db_review_request') {
    if (!isAdmin && !isFaculty) return { error: 'Admin/Faculty only.' };
    const d = data || {};
    if (!d.rollNo || !d.date) return { error: 'rollNo and date required.' };
    const reqDoc = await AttendanceRequest.findOne({ rollNo: d.rollNo.toUpperCase(), date: d.date, status: 'Pending' }).sort({ createdAt: -1 });
    if (!reqDoc) return { error: 'No pending request.' };
    const decision = d.decision === 'Rejected' ? 'Rejected' : 'Approved';
    if (decision === 'Rejected') {
      reqDoc.status = 'Rejected'; reqDoc.reviewedBy = userContext.rollNo; reqDoc.adminNote = d.note || '';
      reqDoc.reviewHistory.push({ action: 'Rejected', by: userContext.rollNo, at: new Date(), note: d.note || '' });
      await reqDoc.save();
      return { reply: `❌ Request rejected for ${d.rollNo} (${d.date}).`, isReply: true };
    }
    const b = reqDoc.branch || 'CSE';
    const schedule = getScheduleForDate(reqDoc.date, b);
    let subs = [];
    if (reqDoc.lectureType === 'full_day') subs = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
    else if (reqDoc.subject) subs = [mapToCanonical(reqDoc.subject)];
    let marked = 0;
    for (const sub of subs) { try { const ex = await Attendance.findOne({ rollNo: reqDoc.rollNo, subject: sub, date: reqDoc.date }); if (!ex) { await Attendance.create({ rollNo: reqDoc.rollNo, studentName: reqDoc.studentName, subject: sub, date: reqDoc.date, status: 'Present', location: null, ipAddress: 'chat-review', isVerified: false, branch: b }); marked++; } } catch (e) {} }
    reqDoc.status = 'Approved'; reqDoc.reviewedBy = userContext.rollNo; reqDoc.adminNote = d.note || '';
    reqDoc.reviewHistory.push({ action: 'Approved', by: userContext.rollNo, at: new Date(), note: d.note || '', reviewedSubjects: subs });
    await reqDoc.save();
    sendPushToRollNo(reqDoc.rollNo, '✅ Request Approved', `${reqDoc.date} — ${marked} marked.`, { type: 'request_approved' }).catch(() => {});
    return { reply: `✅ Approved ${d.rollNo} (${d.date}). Marked **${marked}** lecture(s).`, isReply: true };
  }
  if (action === 'db_add_user') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.name || !d.rollNo) return { error: 'name and rollNo required.' };
    const role = d.role || 'student';
    const cleanRoll = d.rollNo.trim().toUpperCase();
    if (role === 'student' && !/^24(CSE|AIDS)\d{2}$/.test(cleanRoll)) return { error: 'Invalid student roll (24CSE01).' };
    const dup = await User.findOne({ rollNo: cleanRoll });
    if (dup) return { error: 'Roll already exists.' };
    const pass = d.password || '123456';
    const hashed = await bcrypt.hash(pass, 10);
    const branch = role === 'student' && cleanRoll.includes('AIDS') ? 'AIDS' : 'CSE';
    await User.create({ name: d.name, rollNo: cleanRoll, password: hashed, role, branch, facultySubject: role === 'faculty' ? (d.subject || null) : null });
    if (role === 'faculty' && d.subject) await TeacherSubject.create({ teacherRollNo: cleanRoll, subject: mapToCanonical(d.subject), assignedBy: userContext.rollNo });
    return { reply: `✅ Registered **${d.name}** as **${role}** (Roll: ${cleanRoll})${role === 'faculty' ? '\nSubject: ' + d.subject : ''}\nPassword: ${pass}`, isReply: true };
  }
  if (action === 'db_delete_user') {
    if (!isAdmin) return { error: 'Admin only.' };
    if (!data?.rollNo) return { error: 'rollNo required.' };
    const rn = data.rollNo.toUpperCase();
    await User.findOneAndDelete({ rollNo: rn });
    await Attendance.deleteMany({ rollNo: rn });
    await TeacherSubject.deleteMany({ teacherRollNo: rn });
    await AttendanceRequest.deleteMany({ rollNo: rn });
    return { reply: `✅ Deleted **${rn}** and all related data.`, isReply: true };
  }
  if (action === 'db_reset_password') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.rollNo) return { error: 'rollNo required.' };
    const pass = d.newPassword || '123456';
    const hashed = await bcrypt.hash(pass, 10);
    const u = await User.findOneAndUpdate({ rollNo: d.rollNo.toUpperCase() }, { password: hashed });
    if (!u) return { error: 'User not found.' };
    return { reply: `✅ Reset password for **${d.rollNo}**.\nNew password: **${pass}**`, isReply: true };
  }
  if (action === 'db_reset_device') {
    if (!isAdmin) return { error: 'Admin only.' };
    if (!data?.rollNo) return { error: 'rollNo required.' };
    const u = await User.findOneAndUpdate({ rollNo: data.rollNo.toUpperCase() }, { boundDeviceId: null });
    if (!u) return { error: 'User not found.' };
    return { reply: `✅ Device reset for **${data.rollNo}**. They can now log in from a new phone.`, isReply: true };
  }
  if (action === 'db_update_roll') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.oldRoll || !d.newRoll) return { error: 'oldRoll and newRoll required.' };
    const oldR = d.oldRoll.toUpperCase(), newR = d.newRoll.toUpperCase();
    await User.findOneAndUpdate({ rollNo: oldR }, { rollNo: newR });
    await Attendance.updateMany({ rollNo: oldR }, { rollNo: newR });
    return { reply: `✅ Roll updated: **${oldR}** → **${newR}**`, isReply: true };
  }
  if (action === 'db_broadcast_notice') {
    if (!isAdmin) return { error: 'Admin only.' };
    if (!data?.message) return { error: 'message required.' };
    await Notice.create({ title: data.title || 'Announcement', message: data.message, postedBy: userContext.rollNo });
    sendPushToAllUsers(`📢 ${data.title || 'Announcement'}`, data.message, { type: 'notice' }).catch(() => {});
    return { reply: `📢 **Notice Published**\n\n"${data.message}"\n\nAll users will see this.`, isReply: true };
  }
  if (action === 'db_clear_notice') {
    if (!isAdmin) return { error: 'Admin only.' };
    await Notice.deleteMany({});
    return { reply: `✅ All notices cleared.`, isReply: true };
  }
  if (action === 'db_add_holiday') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.date || !d.reason) return { error: 'date and reason required.' };
    const parts = d.date.split('-');
    const dobj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dobj < SEMESTER_START) return { error: 'Before semester start.' };
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dn = days[dobj.getDay()];
    if (dn === 'Saturday' || dn === 'Sunday') return { error: `${d.date} is a weekend — not needed.` };
    await Holiday.findOneAndUpdate({ date: d.date }, { date: d.date, reason: d.reason }, { upsert: true });
    sendPushToAllUsers('🎉 Holiday Announced', `${d.date} — ${d.reason}. College will remain closed.`, { type: 'holiday_added' }).catch(() => {});
    return { reply: `🎉 Holiday added: **${d.date}** — ${d.reason}`, isReply: true };
  }
  if (action === 'db_delete_holiday') {
    if (!isAdmin) return { error: 'Admin only.' };
    if (!data?.date) return { error: 'date required.' };
    const r = await Holiday.findOneAndDelete({ date: data.date });
    if (!r) return { error: 'Holiday not found.' };
    sendPushToAllUsers('⚠️ Holiday Cancelled', `${data.date} holiday removed. College will remain OPEN.`, { type: 'holiday_cancelled' }).catch(() => {});
    return { reply: `✅ Deleted holiday **${data.date}**.`, isReply: true };
  }
  if (action === 'db_list_holidays') {
    const hols = await Holiday.find({}).sort({ date: 1 }).lean();
    if (!hols.length) return { reply: 'No holidays yet.', isReply: true };
    return { reply: `🎉 **Holidays (${hols.length})**\n\n` + hols.slice(0, 40).map(h => `• ${h.date} — ${h.reason}`).join('\n'), isReply: true };
  }
  if (action === 'db_publish_passcode') {
    if (!isAdmin && !isFaculty) return { error: 'Admin/Faculty only.' };
    const d = data || {};
    const type = d.type || 'single_lecture';
    const durationMinutes = parseInt(d.durationMinutes) || (type === 'full_day' ? 1440 : 30);
    const now = new Date(); const todayStr = getISTDateString(now);
    const ds = await checkDateStatus(todayStr);
    if (ds.isBlocked) return { error: 'College closed today.' };
    let passcode, expiry, key;
    if (type === 'single_lecture') { const period = getCurrentPeriod(userContext.branch || 'CSE'); if (!period) return { error: 'No active lecture.' }; key = `single_lecture_${todayStr}_${period.start}`; passcode = Math.floor(1000 + Math.random() * 9000).toString(); expiry = new Date(now.getTime() + durationMinutes * 60 * 1000); }
    else { key = `full_day_${todayStr}`; passcode = Math.floor(10000 + Math.random() * 90000).toString(); expiry = new Date(now.getTime() + durationMinutes * 60 * 1000); }
    await Passcode.deleteMany({ key });
    await Passcode.create({ passcode, type, key, expiresAt: expiry, published: true, isPublic: true, enabled: true, publishedAt: now, publishedBy: userContext.rollNo, durationMinutes });
    sendPushToAllStudents(`🔐 ${type === 'full_day' ? 'Full Day' : 'Lecture'} Passcode Published`, `Passcode: ${passcode} — valid ${durationMinutes} min`, { type: 'passcode' }).catch(() => {});
    return { reply: `📢 **Passcode Published!**\n\nType: **${type.replace('_',' ')}**\nPasscode: **${passcode}**\nValid: **${durationMinutes} min**\n\nStudents will now see this passcode.`, isReply: true };
  }
  if (action === 'db_toggle_passcode') {
    if (!isAdmin) return { error: 'Admin only.' };
    const enabled = data?.enabled === true;
    await Passcode.updateMany({}, { $set: { enabled } });
    return { reply: `✅ Passcode system **${enabled ? 'ENABLED' : 'DISABLED'}**.`, isReply: true };
  }
  if (action === 'db_passcode_status') {
    if (!isAdmin) return { error: 'Admin only.' };
    const status = await getPasscodeSystemStatus();
    let txt = `🔐 **Passcode System**\n\n• Status: **${status.systemEnabled ? '✅ ENABLED' : '⛔ DISABLED'}**\n• Total passcodes: ${status.totalPasscodes}\n• Enabled: ${status.enabledCount}\n• Today active: ${status.todayCount}`;
    if (status.activePublishedPublic.length) txt += `\n\n**Published:**\n` + status.activePublishedPublic.map(p => `• ${p.type}: **${p.passcode}** (expires ${p.expiresIn})`).join('\n');
    return { reply: txt, isReply: true };
  }
  if (action === 'db_list_requests') {
    if (!isAdmin && !isFaculty) return { error: 'Admin/Faculty only.' };
    const status = data?.status || 'Pending';
    let q = {};
    if (status !== 'ALL') q.status = status;
    if (isFaculty) q.branch = userContext.branch;
    const reqs = await AttendanceRequest.find(q).sort({ createdAt: -1 }).limit(30).lean();
    if (!reqs.length) return { reply: `No ${status} requests.`, isReply: true };
    return { reply: `📋 **${status} Requests (${reqs.length})**\n\n` + reqs.map(r => `• ${r.rollNo} (${r.studentName}) — ${r.date} — ${r.lectureType.replace('_',' ')}${r.subject ? ' — ' + r.subject : ''}`).join('\n'), isReply: true };
  }
  if (action === 'db_bulk_review') {
    if (!isAdmin) return { error: 'Admin only.' };
    const decision = data?.decision === 'Rejected' ? 'Rejected' : 'Approved';
    const pending = await AttendanceRequest.find({ status: 'Pending' });
    if (!pending.length) return { reply: 'No pending requests.', isReply: true };
    let totalMarked = 0, processed = 0;
    for (const r of pending) {
      processed++;
      if (decision === 'Rejected') { r.status = 'Rejected'; r.reviewedBy = userContext.rollNo; r.reviewHistory.push({ action: 'Rejected', by: userContext.rollNo, at: new Date() }); await r.save(); sendPushToRollNo(r.rollNo, '❌ Request Rejected', r.date, { type: 'request_rejected' }).catch(() => {}); }
      else {
        const b = r.branch || 'CSE';
        const schedule = getScheduleForDate(r.date, b);
        let subs = [];
        if (r.lectureType === 'full_day') subs = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
        else if (r.subject) subs = [mapToCanonical(r.subject)];
        let mk = 0;
        for (const sub of subs) { try { const ex = await Attendance.findOne({ rollNo: r.rollNo, subject: sub, date: r.date }); if (!ex) { await Attendance.create({ rollNo: r.rollNo, studentName: r.studentName, subject: sub, date: r.date, status: 'Present', location: null, ipAddress: 'bulk-review', isVerified: false, branch: b }); mk++; } } catch (e) {} }
        r.status = 'Approved'; r.reviewedBy = userContext.rollNo; r.reviewHistory.push({ action: 'Approved', by: userContext.rollNo, at: new Date(), reviewedSubjects: subs }); await r.save();
        totalMarked += mk;
        sendPushToRollNo(r.rollNo, '✅ Request Approved', `${r.date} — ${mk} marked.`, { type: 'request_approved' }).catch(() => {});
      }
    }
    return { reply: decision === 'Rejected' ? `❌ Rejected **${processed}** request(s).` : `✅ Approved **${processed}** request(s). Marked **${totalMarked}** lecture(s).`, isReply: true };
  }
  if (action === 'db_clear_requests') {
    if (!isAdmin) return { error: 'Admin only.' };
    const r = await AttendanceRequest.deleteMany({});
    return { reply: `✅ Deleted **${r.deletedCount}** attendance request(s).`, isReply: true };
  }
  if (action === 'db_list_registrations') {
    if (!isAdmin) return { error: 'Admin only.' };
    const status = data?.status || 'Pending';
    const q = status === 'ALL' ? {} : { status };
    const reqs = await RegistrationRequest.find(q).sort({ createdAt: -1 }).limit(50).lean();
    if (!reqs.length) return { reply: `No ${status} registration requests.`, isReply: true };
    return { reply: `📝 **Registration Requests (${reqs.length})**\n\n` + reqs.map(r => `• ${r.rollNo} — ${r.name} — ${r.branch} — **${r.status}**`).join('\n'), isReply: true };
  }
  if (action === 'db_review_registration') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.rollNo || !['Approved','Rejected'].includes(d.decision)) return { error: 'rollNo and decision required.' };
    const r = await RegistrationRequest.findOne({ rollNo: d.rollNo.toUpperCase(), status: 'Pending' }).sort({ createdAt: -1 });
    if (!r) return { error: 'No pending registration found.' };
    r.status = d.decision; r.reviewedBy = userContext.rollNo; r.adminNote = d.note || '';
    if (d.decision === 'Approved') { const dup = await User.findOne({ rollNo: r.rollNo }); if (dup) { r.status = 'Rejected'; r.adminNote += ' User exists'; await r.save(); return { error: 'User exists.' }; } await User.create({ name: r.name, rollNo: r.rollNo, password: r.password, role: 'student', branch: r.branch, boundDeviceId: r.deviceId || null }); r.approvedUserRollNo = r.rollNo; }
    await r.save();
    return { reply: `${d.decision === 'Approved' ? '✅' : '❌'} Registration **${d.decision}** for ${r.rollNo} (${r.name}).`, isReply: true };
  }
  if (action === 'db_clear_registrations') {
    if (!isAdmin) return { error: 'Admin only.' };
    const r = await RegistrationRequest.deleteMany({});
    return { reply: `✅ Deleted **${r.deletedCount}** registration request(s).`, isReply: true };
  }
  if (action === 'db_list_account_requests') {
    if (!isAdmin) return { error: 'Admin only.' };
    const reqs = await AccountRequest.find({}).sort({ createdAt: -1 }).limit(50).lean();
    if (!reqs.length) return { reply: 'No account requests.', isReply: true };
    return { reply: `🔐 **Account Requests (${reqs.length})**\n\n` + reqs.map(r => `• ${r.rollNo} — ${r.type.replace('_',' ')} — **${r.status}**`).join('\n'), isReply: true };
  }
  if (action === 'db_review_account_request') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.requestId || !d.decision) return { error: 'requestId and decision required.' };
    const r = await AccountRequest.findById(d.requestId);
    if (!r) return { error: 'Request not found.' };
    r.status = d.decision === 'Rejected' ? 'Rejected' : 'Approved';
    r.reviewedBy = userContext.rollNo; r.adminNote = d.note || '';
    await r.save();
    if (r.status === 'Approved' && r.type === 'device_reset') await User.updateOne({ rollNo: r.rollNo }, { $set: { boundDeviceId: null } });
    return { reply: `${r.status === 'Approved' ? '✅' : '❌'} Account request **${r.status}**.`, isReply: true };
  }
  if (action === 'db_clear_account_requests') {
    if (!isAdmin) return { error: 'Admin only.' };
    const r = await AccountRequest.deleteMany({});
    return { reply: `✅ Deleted **${r.deletedCount}** account request(s).`, isReply: true };
  }
  if (action === 'db_list_leave') {
    if (!isAdmin) return { error: 'Admin only.' };
    const reqs = await Leave.find({}).sort({ createdAt: -1 }).limit(50).lean();
    if (!reqs.length) return { reply: 'No leave requests.', isReply: true };
    return { reply: `📋 **Leave Requests (${reqs.length})**\n\n` + reqs.map(r => `• ${r.rollNo} (${r.studentName}) — ${r.fromDate}→${r.toDate} — **${r.status}**`).join('\n'), isReply: true };
  }
  if (action === 'db_review_leave') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.leaveId || !d.decision) return { error: 'leaveId and decision required.' };
    const leave = await Leave.findById(d.leaveId);
    if (!leave) return { error: 'Leave not found.' };
    leave.status = d.decision === 'Rejected' ? 'Rejected' : 'Approved';
    leave.reviewedBy = userContext.rollNo; leave.adminNote = d.note || '';
    await leave.save();
    return { reply: `${leave.status === 'Approved' ? '✅' : '❌'} Leave **${leave.status}** for ${leave.rollNo}.`, isReply: true };
  }
  if (action === 'db_clear_leaves') {
    if (!isAdmin) return { error: 'Admin only.' };
    const r = await Leave.deleteMany({});
    return { reply: `✅ Deleted **${r.deletedCount}** leave request(s).`, isReply: true };
  }
  if (action === 'db_manual_mark') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.rollNo || !d.date) return { error: 'rollNo and date required.' };
    const ds = await checkDateStatus(d.date);
    if (ds.isBlocked) return { error: 'Date blocked.' };
    const user = await User.findOne({ rollNo: d.rollNo.toUpperCase(), role: 'student' });
    if (!user) return { error: 'Student not found.' };
    const b = user.branch || 'CSE';
    let toMark = d.subjects?.length ? d.subjects : (getTimetableForBranch(b)[ds.dayName] || []).map(x => mapToCanonical(x.subject));
    const uniq = [...new Set(toMark.map(mapToCanonical).filter(s => !s.includes('LIB') && !s.includes('Sports')))];
    let marked = 0;
    for (const sub of uniq) { try { const ex = await Attendance.findOne({ rollNo: user.rollNo, subject: sub, date: d.date }); if (!ex) { await Attendance.create({ rollNo: user.rollNo, studentName: user.name, subject: sub, date: d.date, status: d.status || 'Present', location: null, ipAddress: 'chat-manual', isVerified: false, branch: b }); marked++; } } catch (e) {} }
    return { reply: `✅ Marked **${marked}** subject(s) for ${d.rollNo} on ${d.date}.`, isReply: true };
  }
  if (action === 'db_bulk_mark') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.studentRollNos?.length || !d.dates?.length) return { error: 'studentRollNos and dates required.' };
    const students = await User.find({ rollNo: { $in: d.studentRollNos }, role: 'student' });
    let marked = 0, skipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE';
      for (const date of d.dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        let toMark = d.subjects?.length ? d.subjects : (getTimetableForBranch(b)[ds.dayName] || []).map(x => mapToCanonical(x.subject));
        const uniq = [...new Set(toMark.map(mapToCanonical).filter(x => !x.includes('LIB') && !x.includes('Sports')))];
        for (const sub of uniq) { try { const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date }); if (!ex) { await Attendance.create({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: 'Present', location: null, ipAddress: 'chat-bulk', isVerified: false, branch: b }); marked++; } else skipped++; } catch (e) { if (e.code === 11000) skipped++; } }
      }
    }
    return { reply: `✅ **Bulk Mark** — New: **${marked}**, Skipped: ${skipped}.`, isReply: true };
  }
  if (action === 'db_bulk_delete') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.studentRollNos?.length || !d.dates?.length) return { error: 'studentRollNos and dates required.' };
    const r = await Attendance.deleteMany({ rollNo: { $in: d.studentRollNos }, date: { $in: d.dates } });
    return { reply: `✅ Deleted **${r.deletedCount}** record(s).`, isReply: true };
  }
  if (action === 'db_top_attendance') {
    if (!isAdmin) return { error: 'Admin only.' };
    const top = await getTopAttendance(parseInt(data?.limit) || 5);
    if (!top.length) return { reply: 'No data.', isReply: true };
    return { reply: `🏆 **Top ${top.length} Attendance**\n\n` + top.map((r, i) => `${i+1}. **${r.rollNo}** (${r.name}) — ${r.present}/${r.total} (**${r.pct}%**)`).join('\n'), isReply: true };
  }
  if (action === 'db_defaulters') {
    if (!isAdmin) return { error: 'Admin only.' };
    const threshold = parseInt(data?.threshold) || 75;
    const students = await User.find({ role: 'student' }).select('rollNo name branch').lean();
    const defaulters = [];
    let scanned = 0;
    for (const s of students) { const summary = await getStudentSummary(s.rollNo); if (!summary) continue; scanned++; if (summary.attendancePercentage < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures }); }
    defaulters.sort((a, b) => a.pct - b.pct);
    if (!defaulters.length) return { reply: `✅ No defaulters below ${threshold}%.`, isReply: true };
    return { reply: `⚠️ **${defaulters.length} Defaulter(s)** (below ${threshold}%)\n\n` + defaulters.slice(0, 30).map(d => `• ${d.rollNo} (${d.name}) — ${d.present}/${d.total} (**${d.pct}%**)`).join('\n'), isReply: true };
  }
  if (action === 'db_impersonate') {
    if (!isAdmin) return { error: 'Admin only.' };
    if (!data?.rollNo) return { error: 'rollNo required.' };
    const imp = await getImpersonationData(data.rollNo);
    if (imp.error) return { error: imp.error };
    let txt = `👤 **${imp.student.name}** (${imp.student.rollNo}) — ${imp.student.branch}\n\n`;
    if (imp.summary) txt += `📊 Attendance: **${imp.summary.attended}/${imp.summary.conducted}** (${imp.summary.percentage}%)\n• Days Present: ${imp.summary.daysPresent}/${imp.summary.workingDaysSoFar}`;
    if (imp.advisor) txt += `\n\n${imp.advisor.message}`;
    return { reply: txt, isReply: true };
  }
  if (action === 'db_fix_attendance') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    let students = d.testRollNo ? await User.find({ rollNo: d.testRollNo.toUpperCase(), role: 'student' }) : await User.find({ role: 'student' });
    let totalRenamed = 0, totalDedup = 0;
    for (const s of students) {
      const allRecords = await Attendance.find({ rollNo: s.rollNo });
      const seen = new Map();
      for (const rec of allRecords) { const canon = mapToCanonical(rec.subject); if (canon !== rec.subject) { rec.subject = canon; await rec.save(); totalRenamed++; } const key = `${rec.date}||${canon}`; if (seen.has(key)) { await Attendance.deleteOne({ _id: rec._id }); totalDedup++; } else seen.set(key, rec._id); }
    }
    return { reply: `🔧 **Fix Complete**\n\n• Students scanned: ${students.length}\n• Subjects renamed: ${totalRenamed}\n• Duplicates removed: ${totalDedup}`, isReply: true };
  }
  if (action === 'db_assign_subject') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.teacherRollNo || !d.subject) return { error: 'teacherRollNo and subject required.' };
    const t = await User.findOne({ rollNo: d.teacherRollNo.toUpperCase(), role: 'faculty' });
    if (!t) return { error: 'Faculty not found.' };
    const canon = mapToCanonical(d.subject);
    if (await TeacherSubject.findOne({ teacherRollNo: t.rollNo, subject: canon })) return { error: 'Already assigned.' };
    await TeacherSubject.create({ teacherRollNo: t.rollNo, subject: canon, assignedBy: userContext.rollNo });
    return { reply: `✅ Assigned **${canon}** to **${t.name}** (${t.rollNo}).`, isReply: true };
  }
  if (action === 'db_remove_subject') {
    if (!isAdmin) return { error: 'Admin only.' };
    const d = data || {};
    if (!d.teacherRollNo || !d.subject) return { error: 'teacherRollNo and subject required.' };
    await TeacherSubject.findOneAndDelete({ teacherRollNo: d.teacherRollNo.toUpperCase(), subject: mapToCanonical(d.subject) });
    return { reply: `✅ Removed assignment.`, isReply: true };
  }
  if (action === 'db_clear_chats') {
    if (userContext.rollNo === 'guest') return { error: 'Not available for guests.' };
    const r = await Chat.deleteMany({ rollNo: userContext.rollNo });
    return { reply: `✅ Deleted **${r.deletedCount}** chat(s).`, isReply: true };
  }
  if (action === 'db_dashboard_stats') {
    if (!isAdmin) return { error: 'Admin only.' };
    const total = await User.countDocuments({ role: 'student' });
    const today = getISTDateString(new Date());
    const pToday = (await Attendance.distinct('rollNo', { date: today, status: 'Present' })).length;
    const pending = await AttendanceRequest.countDocuments({ status: 'Pending' });
    const wd = await getWorkingDays(SEMESTER_START, new Date());
    const twd = await getWorkingDays(SEMESTER_START, SEMESTER_END);
    return { reply: `📊 **Live Dashboard**\n\n• Total Students: **${total}**\n• Present Today: **${pToday}**\n• Absent Today: **${total - pToday}**\n• Pending Requests: **${pending}**\n• Working Days So Far: ${wd}\n• Full Semester: ${twd}`, isReply: true };
  }
  if (action === 'db_all_users') {
    if (!isAdmin) return { error: 'Admin only.' };
    const role = data?.role;
    const users = await User.find(role ? { role } : {}).select('name rollNo role branch facultySubject').sort({ rollNo: 1 }).limit(50).lean();
    if (!users.length) return { reply: 'No users found.', isReply: true };
    return { reply: `👥 **Users (${users.length})**\n\n` + users.map(u => `• ${u.rollNo} — ${u.name} — **${u.role}**${u.branch ? ' (' + u.branch + ')' : ''}`).join('\n'), isReply: true };
  }
  if (action === 'db_system_health') {
    if (!isAdmin) return { error: 'Admin only.' };
    const h = await getSystemHealth();
    let txt = `🖥️ **System Health**\n\n**Status:** ✅ ${h.status}\n**Uptime:** ${h.uptime}\n**DB:** ${h.database.state} (ping ${h.database.ping})\n**FCM:** ${h.fcm.ready ? '✅ Ready' : '⚠️ Not configured'}\n\n**AI:** ${h.ai.primary.provider} (${h.ai.primary.keysConfigured} keys) → ${h.ai.fallback.provider} (${h.ai.fallback.keysConfigured} keys, ${h.ai.fallback.discovered} discovered)\n\n**Counts:**\n• Users: ${h.counts.totalUsers} (S:${h.counts.students} F:${h.counts.faculty})\n• Attendance: ${h.counts.attendances}\n• Pending: ${h.counts.pendingRequests}\n• Reg Reqs: ${h.counts.pendingRegistrationRequests || 0}\n• Holidays: ${h.counts.holidays}`;
    return { reply: txt, isReply: true };
  }
  if (action === 'db_timetable') {
    const date = data?.date || getISTDateString(new Date());
    const branch = userContext.branch || 'CSE';
    return { reply: getStrictTimetableResponse(date, branch), isReply: true };
  }
  if (action === 'db_bunk_advisor') {
    if (!isStudent) return { error: 'Student only.' };
    const advisor = await getBunkAdvisor(userContext.rollNo);
    if (!advisor) return { error: 'Not found.' };
    let txt = `📊 **Bunk Advisor (Lectures)**\n\n📈 Overall: **${advisor.totalAttended}/${advisor.totalConducted}** (${advisor.percentage}%)\n\n`;
    txt += advisor.status === 'SAFE' ? `✅ **SAFE** — can bunk **${advisor.canBunkLectures} lecture(s)**.` : `⚠️ **DANGER** — Need **${advisor.lecturesNeeded} lecture(s)** more to reach 75%.`;
    return { reply: txt, isReply: true };
  }
  if (action === 'db_geofence_guide') {
    if (!isStudent) return { error: 'Student only.' };
    const g = await getGeofenceGuide(userContext);
    if (g.error) return { error: g.error };
    let txt = `📍 **Attendance Guide**\n\n• Current Time: ${g.currentTime}\n• Status: ${g.todayStatus}\n• Active Lecture: ${g.activePeriod}\n• College Hours: ${g.collegeHours}\n\n`;
    txt += `**Windows:**\n• Live Marking: ${g.attendanceWindow.liveMarking}\n• Request: ${g.attendanceWindow.requestWindow}\n\n`;
    if (g.todayMarked) txt += `**Today Marked:** ${g.todaySubjects.join(', ')}`;
    return { reply: txt, isReply: true };
  }
  if (action === 'db_read' || action === 'db_count' || action === 'db_aggregate') {
    if (isStudent) {
      if (['attendances','leaves','attendancerequests'].includes(collection)) { f = f || {}; f.rollNo = userContext.rollNo; }
      if (collection === 'users') { f = f || {}; f.rollNo = userContext.rollNo; }
    }
    try {
      const Model = collMap[collection];
      if (!Model) return { error: 'Unknown collection' };
      if (action === 'db_read') { let q = Model.find(f || {}); if (sort) q = q.sort(sort); q = q.limit(Math.min(limit || 20, 100)); const docs = await q.lean(); const clean = docs.map(d => { if (!isAdmin) { delete d.password; delete d.activeSession; delete d.boundDeviceId; } return d; }); return { result: clean, count: clean.length }; }
      if (action === 'db_count') return { result: { count: await Model.countDocuments(f || {}) } };
    } catch (e) { return { error: e.message }; }
  }
  return { error: 'Unsupported action: ' + action };
}

// ============================================================
//  SEQUENTIAL FLOW HELPERS (existing — 100% as-is)
// ============================================================
async function setPending(rollNo, type, data, lang) { await PendingAction.deleteMany({ rollNo }); await PendingAction.create({ rollNo, type, data: data || {}, lang: lang || 'english', expiresAt: new Date(Date.now() + 15 * 60 * 1000) }); }
async function getPending(rollNo) { return PendingAction.findOne({ rollNo, expiresAt: { $gt: new Date() } }); }
async function clearPending(rollNo) { await PendingAction.deleteMany({ rollNo }); }
function detectPasscodeInMessage(msg) { if (!msg) return null; const m = msg.match(/\b(\d{4,5})\b/); return m ? m[1] : null; }
function L(lang, key) {
  const dict = {
    need_passcode_full: { english: 'Please send the **5-digit Full Day Passcode**.', hinglish: 'Kripya **5-digit Full Day Passcode** bhejiye.', hindi: 'कृपया **5-अंकों का Full Day Passcode** भेजें।' },
    need_passcode_lecture: { english: 'Please send the **4-digit Single Lecture Passcode**.', hinglish: 'Kripya **4-digit Single Lecture Passcode** bhejiye.', hindi: 'कृपया **4-अंकों का Single Lecture Passcode** भेजें।' },
    bad_passcode: { english: '❌ Invalid or expired passcode. Ask teacher/admin for a fresh one.', hinglish: '❌ Passcode galat hai ya expire ho gaya. Teacher/Admin se naya lein.', hindi: '❌ पासकोड गलत या समाप्त। शिक्षक से नया लें।' },
    passcode_ok_ask_location: { english: '✅ Passcode verified! Now share your location to mark attendance.', hinglish: '✅ Passcode sahi! Ab location share karein attendance mark karne ke liye.', hindi: '✅ पासकोड सही! अब लोकेशन शेयर करें।' },
    no_published_passcode: { english: '⚠️ No passcode is currently published. Please wait for the teacher.', hinglish: '⚠️ Abhi koi passcode publish nahi hua. Teacher ka wait karein.', hindi: '⚠️ अभी कोई पासकोड प्रकाशित नहीं।' },
    no_active_lecture: { english: '⚠️ No active lecture right now.', hinglish: '⚠️ Abhi koi active lecture nahi.', hindi: '⚠️ अभी कोई सक्रिय लेक्चर नहीं।' },
    out_of_range: { english: '❌ You are outside campus (100m limit).', hinglish: '❌ Aap campus se bahar hain (100m limit).', hindi: '❌ आप परिसर से बाहर हैं (100m)।' },
    marked_full: { english: '✅ Full Day attendance marked!', hinglish: '✅ Full Day attendance mark ho gayi!', hindi: '✅ Full Day उपस्थिति लग गई!' },
    marked_lecture: { english: '✅ Lecture attendance marked!', hinglish: '✅ Lecture attendance mark ho gayi!', hindi: '✅ लेक्चर उपस्थिति लग गई!' },
    already_marked: { english: '⚠️ Already marked for today.', hinglish: '⚠️ Aaj ka already mark hai.', hindi: '⚠️ आज का पहले से मार्क है।' },
    location_needed: { english: 'Please share your location using the button below.', hinglish: 'Neeche button se location share karein.', hindi: 'कृपया नीचे बटन से लोकेशन शेयर करें।' }
  };
  const row = dict[key];
  return row ? (row[lang] || row.english) : key;
}

// ============================================================
//  MAIN CHAT (existing — 100% as-is)
// ============================================================
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId, skipGreeting, useContext, useDatabase, location, passcode } = req.body;
    if (!message && !location) return res.status(400).json({ error: 'Message required.' });
    const cr = rollNo?.trim().toUpperCase() || 'guest';
    const useCtx = useContext === true;
    const useDb = useDatabase === true;
    let userData = null, existingChat = null;
    if (cr !== 'guest') {
      try { userData = await User.findOne({ rollNo: cr }); } catch(e){}
      if (threadId) { try { existingChat = await Chat.findOne({ threadId, rollNo: cr }); } catch (e) {} }
    }
    const userRole = userData?.role || role || 'student';
    const userName = userData?.name || name || 'Guest';
    const userBranch = userData?.branch || branch || 'CSE';
    const effectiveThreadId = existingChat?.threadId || threadId || null;
    const tStart = Date.now();
    const thinkingCtx = { userMessage: message, userRole, flags: { languageDetected: null } };
    const sendJson = (obj) => { obj.thinking = buildThinkingSteps({ ...thinkingCtx, latencyMs: Date.now() - tStart }); return res.json(obj); };
    const userLang = detectLanguage(message || '');
    thinkingCtx.flags.languageDetected = userLang;
    console.log(`🌐 [LANG] detected=${userLang} for msg="${(message||'').slice(0,60)}"`);
    if (cr !== 'guest' && userRole === 'student') {
      const pending = await getPending(cr);
      if (pending) {
        const msgLower = (message || '').toLowerCase().trim();
        const pcCandidate = detectPasscodeInMessage(message || '');
        const hasLocation = !!(location && location.latitude && location.longitude);
        const isCancelOrGreeting = /^(hi+|hello+|hey+|namaste|yo|sup|thank|thanks|thx|ok|okay|good morning|good evening|good night|bye|goodbye|see you|no problem|k|hmm+|achha|theek|cancel|exit|stop|quit|abort|chhodo|chhod|band karo|rehne do|nevermind|never mind|forget it|nvm|no thanks|nahi chahiye|mat karo|bhool jao|nahi|🙏|🙌|👍)/i.test(msgLower);
        let isExpected = false;
        if (pending.type === 'awaiting_passcode') isExpected = !!(pcCandidate && pcCandidate.length >= 4 && pcCandidate.length <= 5);
        else if (pending.type === 'awaiting_location') isExpected = hasLocation;
        const shouldEscape = isCancelOrGreeting || (!isExpected && !hasLocation);
        if (shouldEscape) { await clearPending(cr); console.log(`🚪 [PENDING-CLEAR] Cleared ${pending.type} for ${cr}`); }
        else {
          if (pending.type === 'awaiting_passcode') {
            const ptype = pending.data.passcodeType || 'full_day';
            const expectedLen = ptype === 'full_day' ? 5 : 4;
            if (pcCandidate && pcCandidate.length === expectedLen) {
              const passDoc = await Passcode.findOne({ passcode: pcCandidate, type: ptype, expiresAt: { $gt: new Date() }, enabled: true });
              if (!passDoc) return sendJson({ reply: L(userLang, 'bad_passcode'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true, needsPasscode: true, passcodeType: ptype, awaitingPasscode: true });
              pending.type = 'awaiting_location'; pending.data.passcode = pcCandidate; await pending.save();
              thinkingCtx.flags.passcodeVerified = true;
              return sendJson({ reply: L(userLang, 'passcode_ok_ask_location'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true, needsLocation: true, locationForMark: true, lectureType: pending.data.lectureType || 'full_day', passcodeType: ptype });
            } else return sendJson({ reply: L(userLang, ptype === 'full_day' ? 'need_passcode_full' : 'need_passcode_lecture'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true, needsPasscode: true, passcodeType: ptype, awaitingPasscode: true });
          }
          if (pending.type === 'awaiting_location') {
            const lc = checkLocation(location.latitude, location.longitude);
            if (!lc.isInside) { await clearPending(cr); console.log(`📍 [LOCATION-REJECTED] ${cr} was ${lc.distance}m away.`); return sendJson({ reply: `❌ **Out of range** (${lc.distance}m away).\n\nYou must be within 100m of BM Group campus to mark attendance.\n\n• Move closer to college\n• Then say **"mark my attendance"** again`, threadId: effectiveThreadId, aiOk: true, usedDatabase: true, locationRejected: true }); }
            const passDoc = await Passcode.findOne({ passcode: pending.data.passcode, type: pending.data.passcodeType, expiresAt: { $gt: new Date() }, enabled: true });
            if (!passDoc) { await clearPending(cr); return sendJson({ reply: L(userLang, 'bad_passcode'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true }); }
            const todayStr = getISTDateString(new Date());
            const lectureType = pending.data.lectureType || 'full_day';
            let replyText = '';
            if (lectureType === 'full_day') {
              const tt = getTimetableForBranch(userBranch);
              const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const dayName = days[new Date().getDay()];
              const acadSet = new Set();
              (tt[dayName] || []).forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes('LIB') && !s.includes('Sports')) acadSet.add(s); });
              const acad = Array.from(acadSet);
              if (!acad.length) { await clearPending(cr); return sendJson({ reply: 'No academic subjects today.', threadId: effectiveThreadId, aiOk: true, usedDatabase: true }); }
              let marked = 0, skipped = 0;
              for (const sub of acad) { try { await Attendance.create({ rollNo: cr, studentName: userName, subject: sub, date: todayStr, status: 'Present', location: { latitude: location.latitude, longitude: location.longitude }, ipAddress: req.ip, isVerified: true, branch: userBranch }); marked++; } catch (e) { if (e.code === 11000) skipped++; } }
              replyText = skipped > 0 && marked === 0 ? L(userLang, 'already_marked') : `${L(userLang, 'marked_full')}\n\n• Marked: ${marked}\n• Location: ${lc.distance}m`;
            } else {
              const period = getCurrentPeriod(userBranch);
              if (!period) { await clearPending(cr); return sendJson({ reply: L(userLang, 'no_active_lecture'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true }); }
              const activeSubj = mapToCanonical(period.subject);
              try { await Attendance.create({ rollNo: cr, studentName: userName, subject: activeSubj, date: todayStr, status: 'Present', location: { latitude: location.latitude, longitude: location.longitude }, ipAddress: req.ip, isVerified: true, branch: userBranch }); }
              catch (e) { if (e.code === 11000) { await clearPending(cr); return sendJson({ reply: L(userLang, 'already_marked'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true }); } }
              replyText = `${L(userLang, 'marked_lecture')}\n\n• ${activeSubj}\n• Location: ${lc.distance}m`;
            }
            await clearPending(cr);
            thinkingCtx.flags.locationVerified = true; thinkingCtx.flags.attendanceMarked = true;
            checkAttendanceMilestone(cr).catch(() => {});
            if (cr !== 'guest') {
              const nt = existingChat || await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: 'Attendance', messages: [] });
              nt.messages.push({ role: 'user', content: `[marked] ${lectureType}` });
              nt.messages.push({ role: 'assistant', content: replyText });
              nt.updatedAt = new Date();
              await nt.save();
              return sendJson({ reply: replyText, threadId: nt.threadId, aiOk: true, usedDatabase: true, marked: true });
            }
            return sendJson({ reply: replyText, threadId: effectiveThreadId, aiOk: true, usedDatabase: true, marked: true });
          }
        }
      }
    }
    if (useDb && userData) {
      try {
        const fastIntent = fastIntentParse(message, userRole);
        let intent;
        if (fastIntent) { intent = fastIntent; thinkingCtx.fastIntent = fastIntent; }
        else { intent = await detectDbIntent(message || 'mark attendance', { role: userRole, rollNo: cr, name: userName, branch: userBranch }, effectiveThreadId); thinkingCtx.aiIntent = intent; }
        console.log('🧠 Intent:', JSON.stringify(intent).substring(0, 200));
        if (intent.action === 'db_live_mark') {
          const lectureType = intent.data?.lectureType || 'full_day';
          const activePasscode = await Passcode.findOne({ type: lectureType, published: true, enabled: true, expiresAt: { $gt: new Date() } }).sort({ publishedAt: -1 });
          if (!activePasscode) return sendJson({ reply: L(userLang, 'no_published_passcode'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true });
          await setPending(cr, 'awaiting_passcode', { lectureType, passcodeType: lectureType }, userLang);
          return sendJson({ reply: L(userLang, lectureType === 'full_day' ? 'need_passcode_full' : 'need_passcode_lecture'), threadId: effectiveThreadId, aiOk: true, usedDatabase: true, needsPasscode: true, passcodeType: lectureType, awaitingPasscode: true });
        }
        if (intent.action !== 'reply') {
          if (intent.requiresConfirmation) return sendJson({ reply: `⚠️ ${intent.explanation || 'Confirm?'}`, threadId: effectiveThreadId, aiOk: true, usedDatabase: true, dbOp: intent, requiresConfirmation: true });
          const execResult = await executeDbAction(intent, { role: userRole, rollNo: cr, name: userName, branch: userBranch }, effectiveThreadId);
          thinkingCtx.execResult = execResult;
          let replyText;
          if (execResult.isReply) replyText = execResult.reply;
          else if (execResult.error) replyText = `❌ ${execResult.error}`;
          else if (execResult.result && execResult.result.message) replyText = execResult.result.message;
          else replyText = `✅ Done`;
          if (cr !== 'guest') {
            if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: replyText }); existingChat.updatedAt = new Date(); await existingChat.save(); }
            else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: (message || 'Chat').substring(0, 50), messages: [{ role: 'user', content: message }, { role: 'assistant', content: replyText }] }); return sendJson({ reply: replyText, threadId: nt.threadId, aiOk: true, usedDatabase: true }); }
          }
          return sendJson({ reply: replyText, threadId: existingChat?.threadId, aiOk: true, usedDatabase: true });
        }
        if (intent.reply) {
          if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: intent.reply }); existingChat.updatedAt = new Date(); await existingChat.save(); }
          return sendJson({ reply: intent.reply, threadId: existingChat?.threadId, aiOk: true, usedDatabase: true });
        }
      } catch (err) { console.warn('DB mode error:', err.message); }
    }
    let contextStr = '';
    if (useCtx && userData) {
      const lines = [];
      const now = new Date();
      const todayStr = getISTDateString(now);
      const tomorrowStr = getISTDateString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      lines.push(`Today: ${todayStr}`); lines.push(`Tomorrow: ${tomorrowStr}`);
      lines.push(`User: ${userData.name} (${userData.rollNo}, ${userData.role})`);
      lines.push(`Branch: ${userData.branch || 'CSE'}`);
      lines.push(`---STRICT_TIMETABLE_TODAY---`);
      lines.push(getStrictTimetableResponse(todayStr, userData.branch || 'CSE'));
      if (userData.role === 'student') {
        const summary = await getStudentSummary(userData.rollNo);
        if (summary) { lines.push(`Attendance: ${summary.totalAcademicLectures}/${summary.totalConductedLectures} (${summary.attendancePercentage}%)`); const advisor = await getBunkAdvisor(userData.rollNo); if (advisor) lines.push(`Bunk Advisor: ${advisor.message}`); }
      }
      contextStr = lines.join('\n');
    }
    const isCasualChat = !useCtx && !useDb && userRole === 'student';
    const langInstruction = languageInstruction(userLang);
    const systemPrompt = `You are "BM Bot" for BM Group of Institutions.

## IDENTITY
You are currently talking to a **${userRole.toUpperCase()}** named **${userName}** (${userBranch}).
- If role=admin → ADMINISTRATOR. NEVER ask them to "turn on Context/Database".
- If role=faculty → FACULTY. Same rule.
- If role=student → STUDENT.

## LANGUAGE MATCHING — HIGHEST PRIORITY
${langInstruction}
RULES:
- NEVER switch language. NEVER use Devanagari for Hinglish users.
- This rule OVERRIDES every other instruction.

${isCasualChat ? '## MODE: CASUAL\nJust chat naturally. For attendance/timetable queries, suggest turning on Context or Database.' : '## MODE: DATA\nAnswer from CONTEXT.'}

FORMATTING:
- Bullet points only (• or -)
- NEVER use markdown tables
- Keep paragraphs short.

${contextStr ? `\n---CONTEXT---\n${contextStr}` : ''}`;
    let reply = '', aiOk = false, provider = 'unknown';
    try { const aiResult = await callAI({ prompt: message, systemPrompt, history: existingChat?.messages, maxTokens: 1200, temperature: 0.5, threadId: effectiveThreadId }); reply = aiResult.reply; provider = aiResult.provider; aiOk = true; thinkingCtx.provider = provider; console.log(`✅ [AI] Reply via ${provider}`); }
    catch (err) { reply = err.message; }
    let newThreadId = threadId, newTitle = 'New Chat';
    if (cr !== 'guest' && aiOk) {
      if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); if (!existingChat.title || existingChat.title === 'New Chat') existingChat.title = message.substring(0, 50); await existingChat.save(); newThreadId = existingChat.threadId; newTitle = existingChat.title; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: message.substring(0, 50) || 'New Chat', messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; newTitle = nt.title; }
    }
    sendJson({ reply, threadId: newThreadId, title: newTitle, aiOk, provider });
  } catch (err) { console.error('❌ Chat error:', err); res.status(500).json({ error: 'Internal error: ' + err.message }); }
});

app.post('/api/ai/chat/confirm-db', async (req, res) => {
  try {
    const { rollNo, operation } = req.body;
    if (!rollNo || !operation) return res.status(400).json({ error: 'rollNo and operation required' });
    const userData = await User.findOne({ rollNo: rollNo.trim().toUpperCase() });
    if (!userData) return res.status(404).json({ error: 'User not found' });
    const execResult = await executeDbAction(operation, { role: userData.role, rollNo: userData.rollNo, name: userData.name, branch: userData.branch || 'CSE' });
    const replyText = execResult.isReply ? execResult.reply : (execResult.error ? `❌ ${execResult.error}` : `✅ Done`);
    res.json({ reply: replyText, aiOk: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/chat-with-file', async (req, res) => {
  try {
    const { prompt, fileBase64, mimeType, rollNo, role, name, branch, threadId } = req.body;
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'fileBase64 and mimeType required.' });
    const userPrompt = prompt || 'Explain this file.';
    const cr = rollNo?.trim().toUpperCase() || 'guest';
    let userData = null;
    if (cr !== 'guest') userData = await User.findOne({ rollNo: cr });
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';
    const userLang = detectLanguage(userPrompt);
    const systemPrompt = `You are "BM Bot" helping ${userName} (${userRole}).\n## LANGUAGE RULE — ${languageInstruction(userLang)}\nAnalyze and summarize. Use markdown bullets. NEVER use markdown tables.`;
    let reply = '', aiOk = false;
    try { reply = await callGemini({ prompt: userPrompt, systemPrompt, fileBase64, mimeType, maxTokens: 3000, temperature: 0.4, threadId }); aiOk = true; }
    catch (err) { reply = err.message; }
    let newThreadId = threadId, newTitle = 'File Analysis';
    if (cr !== 'guest' && aiOk) {
      const existingChat = threadId ? await Chat.findOne({ threadId, rollNo: cr }) : null;
      if (existingChat) { existingChat.messages.push({ role: 'user', content: `[File] ${userPrompt}` }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); await existingChat.save(); newThreadId = existingChat.threadId; newTitle = existingChat.title; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: `File: ${userPrompt.substring(0, 40)}`, messages: [{ role: 'user', content: `[File] ${userPrompt}` }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; newTitle = nt.title; }
    }
    res.json({ reply, threadId: newThreadId, title: newTitle, aiOk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/generate-report-pdf', async (req, res) => {
  try {
    const { rollNo, reportType = 'student-attendance', targetRollNo, startDate, endDate } = req.body;
    const cr = rollNo?.trim().toUpperCase();
    if (!cr) return res.status(400).json({ error: 'rollNo required' });
    const requester = await User.findOne({ rollNo: cr });
    if (!requester) return res.status(404).json({ error: 'User not found' });
    if (reportType === 'admin-defaulters' && requester.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    let pdfBuffer;
    if (reportType === 'student-attendance') {
      const target = targetRollNo ? targetRollNo.trim().toUpperCase() : cr;
      if (requester.role === 'student' && target !== cr) return res.status(403).json({ error: 'Own only.' });
      const targetUser = await User.findOne({ rollNo: target });
      if (!targetUser) return res.status(404).json({ error: 'Target not found' });
      const summary = await getStudentSummary(target);
      if (!summary) return res.status(500).json({ error: 'Cannot compute' });
      const rStart = startDate || getISTDateString(SEMESTER_START);
      let rEnd = endDate || getISTDateString(new Date());
      const todayStr = getISTDateString(new Date());
      if (rEnd > todayStr) rEnd = todayStr;
      const records = await Attendance.find({ rollNo: target, date: { $gte: rStart, $lte: rEnd } }).sort({ date: 1 }).lean();
      const subRows = Object.entries(summary.subjectStats).map(([sub, st]) => [sub, `${st.present}/${st.total}`, `${st.percentage}%`]);
      const sections = [
        { heading: '📊 Overview', bullets: [`Overall: ${summary.totalAcademicLectures}/${summary.totalConductedLectures} (${summary.attendancePercentage}%)`, `Unique Days Present: ${summary.daysPresent}`, `Status: ${summary.attendancePercentage >= 75 ? '✅ Safe' : '⚠️ Below 75%'}`] },
        { heading: '📚 Subject-wise', table: { headers: ['Subject', 'P/T', '%'], rows: subRows } },
        { heading: '📅 Recent', table: { headers: ['Date', 'Subject', 'Status'], rows: records.slice(-30).reverse().map(r => [r.date, mapToCanonical(r.subject), r.status]) } }
      ];
      pdfBuffer = await generatePDFBuffer({ title: 'Student Attendance Report', subtitle: `${targetUser.name} (${target}) • ${targetUser.branch || 'CSE'}`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${target}.pdf`);
      return res.send(pdfBuffer);
    }
    if (reportType === 'admin-defaulters') {
      const threshold = parseInt(req.body.threshold) || 75;
      const students = await User.find({ role: 'student' }).select('rollNo name branch').lean();
      const defaulters = [];
      for (const s of students) { const summary = await getStudentSummary(s.rollNo); if (summary && summary.attendancePercentage < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures }); }
      defaulters.sort((a,b) => a.pct - b.pct);
      const sections = [
        { heading: `⚠️ Defaulters Below ${threshold}%`, text: `Total: ${defaulters.length}/${students.length}` },
        { heading: '📋 List', table: { headers: ['Roll', 'Name', 'Branch', 'P/T', '%'], rows: defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.pct}%`]) } }
      ];
      pdfBuffer = await generatePDFBuffer({ title: 'Defaulter Watchlist', subtitle: `Threshold: ${threshold}%`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=defaulters_${threshold}pct.pdf`);
      return res.send(pdfBuffer);
    }
    res.status(400).json({ error: 'Unknown reportType.' });
  } catch (err) { console.error('❌ PDF error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/requests-summary/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const status = req.query.status || 'Pending';
    const filter = status && status !== 'ALL' ? { status } : {};
    const requests = await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    const counts = { Pending: await AttendanceRequest.countDocuments({ status: 'Pending' }), Approved: await AttendanceRequest.countDocuments({ status: 'Approved' }), Rejected: await AttendanceRequest.countDocuments({ status: 'Rejected' }), PartiallyApproved: await AttendanceRequest.countDocuments({ status: 'Partially Approved' }) };
    res.json({ count: requests.length, counts, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/request/:id/:requesterRollNo', async (req, res) => {
  try {
    const { id, requesterRollNo } = req.params;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const r = await AttendanceRequest.findByIdAndDelete(id);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    res.json({ message: 'Request deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fix-all-attendance-subjects', async (req, res) => {
  try {
    const { requesterRollNo, testRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    let students;
    if (testRollNo) students = await User.find({ rollNo: testRollNo.toUpperCase(), role: 'student' });
    else students = await User.find({ role: 'student' });
    const report = [];
    let totalStudents = 0, totalRemoved = 0, totalAdded = 0, totalRenamed = 0, totalDeduplicated = 0;
    for (const s of students) {
      totalStudents++;
      const allRecords = await Attendance.find({ rollNo: s.rollNo });
      const seen = new Map();
      let removed = 0, added = 0, renamed = 0, dedup = 0;
      for (const rec of allRecords) {
        const canon = mapToCanonical(rec.subject);
        if (canon !== rec.subject) { rec.subject = canon; renamed++; await rec.save(); }
        const key = `${rec.date}||${canon}`;
        if (seen.has(key)) { await Attendance.deleteOne({ _id: rec._id }); dedup++; }
        else seen.set(key, rec._id);
      }
      totalRemoved += removed; totalAdded += added; totalRenamed += renamed; totalDeduplicated += dedup;
      if (removed || added || renamed || dedup) report.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, removed, added, renamed, dedup });
    }
    res.json({ message: 'Fix complete.', totalStudents, removed: totalRemoved, added: totalAdded, renamed: totalRenamed, deduplicated: totalDeduplicated, report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ ALL CRON JOBS (14 total) ★★★
// ============================================================
const _cronFlags = { dailySummary: null, shortageWeekly: null, weeklyReport: null, monthlyProgress: null, birthday: null, pendingAdmin: null, pendingStudent: null, systemHealth: null };
function MONTH_NAME(m) { return ['January','February','March','April','May','June','July','August','September','October','November','December'][m]; }

// 1. ★ Existing: 2:45 PM attendance reminder (with wider window fix)
let _lastReminderDate = null;
function scheduleAttendanceReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now);
      const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      const day = now.getDay();
      if (day === 0 || day === 6) return;
      // Wider window: 2:45 PM to 2:55 PM
      const inWindow = (istHour === 14 && istMin >= 45 && istMin <= 55);
      if (!inWindow) return;
      if (_lastReminderDate === todayStr) return;
      const hol = await Holiday.findOne({ date: todayStr });
      if (hol) { _lastReminderDate = todayStr; return; }
      _lastReminderDate = todayStr;
      console.log(`⏰ [CRON-2:45PM] Sending reminder for ${todayStr}`);
      const result = await sendPushToAllStudents('⏰ Attendance Reminder', 'Live attendance window closes at 3 PM. Mark your attendance now!', { type: 'attendance_reminder', date: todayStr });
      console.log(`📤 [CRON-2:45PM] sent=${result.sent} failed=${result.failed}`);
    } catch (e) { console.warn('⚠️ [CRON-2:45PM]', e.message); }
  }, 60 * 1000);
  console.log('⏰ [CRON] 2:45 PM reminder scheduled');
}

// 2. ★ Daily 9 PM summary (students)
function scheduleDailySummary() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      if (istHour !== 21 || istMin !== 0) return;
      if (_cronFlags.dailySummary === todayStr) return;
      _cronFlags.dailySummary = todayStr;
      const day = now.getDay(); if (day === 0 || day === 6) return;
      const hol = await Holiday.findOne({ date: todayStr }); if (hol) return;
      console.log(`📊 [CRON-9PM] Daily summary for ${todayStr}`);
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo name branch fcmToken').lean();
      let sent = 0;
      for (const s of students) {
        try {
          const tt = getTimetableForBranch(s.branch || 'CSE');
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day];
          const acad = (tt[dayName] || []).filter(x => !x.subject.includes('LIB') && !x.subject.includes('Sports')).map(x => mapToCanonical(x.subject));
          const uniq = [...new Set(acad)];
          const recs = await Attendance.find({ rollNo: s.rollNo, date: todayStr, status: { $in: ['Present', 'Duty Leave'] } }).lean();
          const pSet = new Set(recs.map(r => mapToCanonical(r.subject)));
          let pCount = 0; uniq.forEach(sub => { if (pSet.has(sub)) pCount++; });
          const pct = uniq.length > 0 ? Math.round((pCount / uniq.length) * 100) : 0;
          const summary = await getStudentSummary(s.rollNo);
          const overallPct = summary ? summary.attendancePercentage : 0;
          await sendPushNotification(s.fcmToken, '📊 Today\'s Summary', `Today: ${pCount}/${uniq.length} lectures (${pct}%). Overall: ${overallPct}%`, { type: 'daily_summary' });
          sent++;
        } catch (e) {}
      }
      console.log(`📊 [CRON-9PM] Sent to ${sent} students`);
    } catch (e) { console.warn('⚠️ [CRON-9PM]', e.message); }
  }, 60 * 1000);
  console.log('📊 [CRON] 9 PM daily summary scheduled');
}

// 3. ★ Weekly shortage alert (Monday 10 AM)
function scheduleShortageAlert() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const day = now.getDay(); const todayStr = getISTDateString(now);
      if (day !== 1) return;
      if (istHour !== 10 || istMin !== 0) return;
      if (_cronFlags.shortageWeekly === todayStr) return;
      _cronFlags.shortageWeekly = todayStr;
      console.log(`⚠️ [CRON-SHORTAGE] Weekly scan`);
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo name fcmToken').lean();
      let sent = 0;
      for (const s of students) {
        try {
          const summary = await getStudentSummary(s.rollNo);
          if (!summary) continue;
          if (summary.attendancePercentage < 75) { await sendPushNotification(s.fcmToken, '⚠️ Attendance Warning', `Your attendance is ${summary.attendancePercentage}% — below 75%! Attend lectures regularly.`, { type: 'shortage_alert' }); sent++; }
          else if (summary.attendancePercentage < 80) { await sendPushNotification(s.fcmToken, '⚡ Attendance Near Limit', `Your attendance is ${summary.attendancePercentage}% — stay above 75%!`, { type: 'shortage_warning' }); sent++; }
        } catch (e) {}
      }
      console.log(`⚠️ [CRON-SHORTAGE] Warned ${sent}`);
    } catch (e) { console.warn('⚠️ [CRON-SHORTAGE]', e.message); }
  }, 60 * 1000);
  console.log('⚠️ [CRON] Weekly shortage alert scheduled');
}

// 4. ★ Sunday 8 PM weekly report
function scheduleWeeklyReport() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const day = now.getDay(); const todayStr = getISTDateString(now);
      if (day !== 0) return;
      if (istHour !== 20 || istMin !== 0) return;
      if (_cronFlags.weeklyReport === todayStr) return;
      _cronFlags.weeklyReport = todayStr;
      console.log(`📈 [CRON-WEEKLY] Weekly report`);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const weekAgoStr = getISTDateString(weekAgo);
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo fcmToken').lean();
      let sent = 0;
      for (const s of students) {
        try {
          const recs = await Attendance.find({ rollNo: s.rollNo, date: { $gte: weekAgoStr, $lte: todayStr } }).lean();
          const present = recs.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
          const pct = recs.length > 0 ? Math.round((present / recs.length) * 100) : 0;
          await sendPushNotification(s.fcmToken, '📈 Weekly Report', `This week: ${present}/${recs.length} (${pct}%). Keep going!`, { type: 'weekly_report' });
          sent++;
        } catch (e) {}
      }
      console.log(`📈 [CRON-WEEKLY] Sent to ${sent}`);
    } catch (e) { console.warn('⚠️ [CRON-WEEKLY]', e.message); }
  }, 60 * 1000);
  console.log('📈 [CRON] Sunday 8 PM weekly report scheduled');
}

// 5. ★ Monthly progress (last day 8 PM)
function scheduleMonthlyProgress() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      if (tomorrow.getDate() !== 1) return;
      if (istHour !== 20 || istMin !== 0) return;
      if (_cronFlags.monthlyProgress === todayStr) return;
      _cronFlags.monthlyProgress = todayStr;
      console.log(`📊 [CRON-MONTHLY] ${todayStr}`);
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo fcmToken').lean();
      let sent = 0;
      for (const s of students) {
        try {
          const summary = await getStudentSummary(s.rollNo);
          if (!summary) continue;
          const emoji = summary.attendancePercentage >= 75 ? '✅' : '⚠️';
          await sendPushNotification(s.fcmToken, `📊 ${MONTH_NAME(now.getMonth())} Summary`, `${emoji} Overall: ${summary.attendancePercentage}% (${summary.totalAcademicLectures}/${summary.totalConductedLectures})`, { type: 'monthly_progress' });
          sent++;
        } catch (e) {}
      }
      console.log(`📊 [CRON-MONTHLY] Sent to ${sent}`);
    } catch (e) { console.warn('⚠️ [CRON-MONTHLY]', e.message); }
  }, 60 * 1000);
  console.log('📊 [CRON] Monthly progress scheduled');
}

// 6. ★ Birthday wishes (9 AM daily)
function scheduleBirthdayWish() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      if (istHour !== 9 || istMin !== 0) return;
      if (_cronFlags.birthday === todayStr) return;
      _cronFlags.birthday = todayStr;
      const todayMD = todayStr.substring(5);
      const students = await User.find({ role: 'student', dateOfBirth: { $ne: null } }).lean();
      for (const s of students) {
        if (!s.dateOfBirth) continue;
        const md = s.dateOfBirth.substring(5);
        if (md === todayMD) { try { await sendPushNotification(s.fcmToken, '🎂 Happy Birthday!', `Wishing you a wonderful day, ${s.name}! - BM Group`, { type: 'birthday' }); } catch (e) {} }
      }
    } catch (e) { console.warn('⚠️ [CRON-BIRTHDAY]', e.message); }
  }, 60 * 1000);
  console.log('🎂 [CRON] Birthday wishes scheduled');
}

// 7. ★ Fee due reminder (10 AM daily)
function scheduleFeeReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      if (istHour !== 10 || istMin !== 0) return;
      const fees = await Fee.find({ status: { $ne: 'Paid' } }).lean();
      for (const fee of fees) {
        try {
          const dueD = new Date(fee.dueDate + 'T00:00:00');
          const todayD = new Date(todayStr + 'T00:00:00');
          const daysLeft = Math.round((dueD - todayD) / (24 * 60 * 60 * 1000));
          let reminderKey = null;
          if (daysLeft === 7) reminderKey = '7d'; else if (daysLeft === 3) reminderKey = '3d'; else if (daysLeft === 1) reminderKey = '1d'; else if (daysLeft === 0) reminderKey = 'due'; else if (daysLeft < 0) reminderKey = 'overdue';
          if (!reminderKey) continue;
          if (fee.remindersSent && fee.remindersSent.includes(reminderKey)) continue;
          const msg = daysLeft > 0 ? `Fee of ₹${fee.amount} due on ${fee.dueDate}. ${daysLeft} day(s) remaining.` : daysLeft === 0 ? `Fee of ₹${fee.amount} due TODAY (${fee.dueDate}). Pay now!` : `Fee of ₹${fee.amount} is OVERDUE since ${fee.dueDate}. Pay immediately.`;
          await sendPushToRollNo(fee.rollNo, daysLeft < 0 ? '💰 Fee OVERDUE' : '💰 Fee Due Reminder', msg, { type: 'fee_reminder', dueDate: fee.dueDate });
          await Fee.updateOne({ _id: fee._id }, { $push: { remindersSent: reminderKey } });
        } catch (e) {}
      }
    } catch (e) { console.warn('⚠️ [CRON-FEE]', e.message); }
  }, 60 * 1000);
  console.log('💰 [CRON] Fee reminder scheduled');
}

// 8. ★ Assignment deadline (6 PM daily, 24h before)
function scheduleAssignmentReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      if (istHour !== 18 || istMin !== 0) return;
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const tomorrowStr = getISTDateString(tomorrow);
      const assignments = await Assignment.find({ dueDate: tomorrowStr }).lean();
      for (const a of assignments) {
        try {
          if (a.remindersSent && a.remindersSent.includes('24h')) continue;
          await sendPushToBranch(a.branch, '📝 Assignment Due Tomorrow', `${a.title} — ${a.subject} — Due tomorrow (${a.dueDate})`, { type: 'assignment_deadline', assignmentId: a._id.toString() });
          await Assignment.updateOne({ _id: a._id }, { $push: { remindersSent: '24h' } });
        } catch (e) {}
      }
    } catch (e) { console.warn('⚠️ [CRON-ASSIGNMENT]', e.message); }
  }, 60 * 1000);
  console.log('📝 [CRON] Assignment deadline reminder scheduled');
}

// 9. ★ Exam reminder (9 AM daily, 3 days before)
function scheduleExamReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      if (istHour !== 9 || istMin !== 0) return;
      const checkDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const checkStr = getISTDateString(checkDate);
      const exams = await Exam.find({ examDate: checkStr }).lean();
      for (const ex of exams) {
        try {
          if (ex.remindersSent && ex.remindersSent.includes('3d')) continue;
          await sendPushToBranch(ex.branch, '📝 Exam in 3 Days', `${ex.subject} — ${ex.examType} on ${ex.examDate} at ${ex.startTime} (${ex.venue})`, { type: 'exam_reminder', examId: ex._id.toString() });
          await Exam.updateOne({ _id: ex._id }, { $push: { remindersSent: '3d' } });
        } catch (e) {}
      }
    } catch (e) { console.warn('⚠️ [CRON-EXAM]', e.message); }
  }, 60 * 1000);
  console.log('📝 [CRON] Exam reminder scheduled');
}

// 10. ★ Library due (10:05 AM daily, 2 days before)
function scheduleLibraryReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      if (istHour !== 10 || istMin !== 5) return;
      const checkDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const checkStr = getISTDateString(checkDate);
      const books = await LibraryBook.find({ dueDate: checkStr, status: 'Issued' }).lean();
      for (const b of books) {
        try {
          if (b.remindersSent && b.remindersSent.includes('2d')) continue;
          await sendPushToRollNo(b.rollNo, '📚 Book Return Reminder', `"${b.bookTitle}" due on ${b.dueDate}. Return or renew.`, { type: 'library_due', bookId: b._id.toString() });
          await LibraryBook.updateOne({ _id: b._id }, { $push: { remindersSent: '2d' } });
        } catch (e) {}
      }
    } catch (e) { console.warn('⚠️ [CRON-LIBRARY]', e.message); }
  }, 60 * 1000);
  console.log('📚 [CRON] Library due reminder scheduled');
}

// 11. ★ Faculty class reminder (5 min before)
function scheduleFacultyClassReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const day = now.getDay();
      if (day === 0 || day === 6) return;
      const istMin = getISTMinutes(now);
      for (const branch of ['CSE', 'AIDS']) {
        const schedule = getScheduleForBranch(branch);
        const daySchedule = schedule[day] || [];
        for (const slot of daySchedule) {
          if (slot.period === 'LUNCH') continue;
          const startMins = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);
          if (istMin !== startMins - 5) continue;
          const faculty = await User.find({ role: 'faculty', fcmToken: { $ne: null } }).lean();
          for (const f of faculty) {
            try {
              const teaches = await TeacherSubject.findOne({ teacherRollNo: f.rollNo, subject: mapToCanonical(slot.subject) });
              if (teaches) await sendPushNotification(f.fcmToken, '⏰ Class Starting in 5 min', `${slot.subject} at ${slot.start} — ${slot.faculty}`, { type: 'faculty_class_reminder' });
            } catch (e) {}
          }
        }
      }
    } catch (e) { console.warn('⚠️ [CRON-FACULTY]', e.message); }
  }, 60 * 1000);
  console.log('⏰ [CRON] Faculty class reminder scheduled');
}

// 12. ★ Admin pending reminder (11 AM daily)
function schedulePendingAdminReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      if (istHour !== 11 || istMin !== 0) return;
      if (_cronFlags.pendingAdmin === todayStr) return;
      _cronFlags.pendingAdmin = todayStr;
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const pending = await AttendanceRequest.countDocuments({ status: 'Pending', createdAt: { $lt: cutoff } });
      const leaves = await Leave.countDocuments({ status: 'Pending', createdAt: { $lt: cutoff } });
      const regs = await RegistrationRequest.countDocuments({ status: 'Pending', createdAt: { $lt: cutoff } });
      const total = pending + leaves + regs;
      if (total > 0) await sendPushToRole('admin', '⏰ Pending Requests', `${total} request(s) pending for 24+ hours. Review needed.`, { type: 'pending_admin_reminder' });
    } catch (e) { console.warn('⚠️ [CRON-PENDING-ADMIN]', e.message); }
  }, 60 * 1000);
  console.log('⏰ [CRON] Admin pending reminder scheduled');
}

// 13. ★ Student pending reminder (6:05 PM daily)
function schedulePendingStudentReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      if (istHour !== 18 || istMin !== 5) return;
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const pending = await AttendanceRequest.find({ status: 'Pending', createdAt: { $lt: cutoff } }).lean();
      for (const p of pending) { try { await sendPushToRollNo(p.rollNo, '📋 Request Still Pending', `Your ${p.date} request is still pending with admin.`, { type: 'request_pending_student' }); } catch (e) {} }
    } catch (e) { console.warn('⚠️ [CRON-PENDING-STUDENT]', e.message); }
  }, 60 * 1000);
  console.log('📋 [CRON] Student pending reminder scheduled');
}

// 14. ★ System health check (hourly)
function scheduleSystemHealthCheck() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istMin = getISTMinutes(now);
      if (istMin !== 0) return;
      const dbState = mongoose.connection.readyState;
      if (dbState !== 1) { console.warn('🚨 [HEALTH] DB not connected:', dbState); await sendPushToRole('admin', '🚨 System Alert', `Database connection issue. Check immediately.`, { type: 'system_alert' }); }
    } catch (e) { console.warn('⚠️ [CRON-HEALTH]', e.message); }
  }, 60 * 1000);
  console.log('🚨 [CRON] System health check scheduled');
}

// Start all 14 CRON jobs
scheduleAttendanceReminder();
scheduleDailySummary();
scheduleShortageAlert();
scheduleWeeklyReport();
scheduleMonthlyProgress();
scheduleBirthdayWish();
scheduleFeeReminder();
scheduleAssignmentReminder();
scheduleExamReminder();
scheduleLibraryReminder();
scheduleFacultyClassReminder();
schedulePendingAdminReminder();
schedulePendingStudentReminder();
scheduleSystemHealthCheck();
console.log('✅ [CRON] All 14 notification schedules initialized');

// ---------- Global Handlers ----------
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); process.exit(1); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
  console.log(`🤖 AI: Groq(${GROQ_API_KEYS.length} keys) → Gemini(${GEMINI_API_KEYS.length} keys)`);
  console.log(`🔥 FCM: ${fcmReady ? 'READY ✅' : 'DISABLED ⚠️'}`);
  console.log(`📦 Version: 4.0 (All existing + 14 CRONs + 7 new schemas + 30+ new endpoints)`);
});
