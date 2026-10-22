// ================= index.js v5.0 — Subscriptions, Real UPI Payments, Gamification =================
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone: ${process.env.TZ}`);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ============================================================
//  RAZORPAY INIT
// ============================================================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret'
});

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
  }
} catch (e) { console.error('❌ Firebase Admin init failed:', e.message); fcmReady = false; }

async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!fcmReady || !fcmToken) return { ok: false, reason: !fcmReady ? 'not-ready' : 'no-token' };
  try {
    const stringData = Object.fromEntries(
      Object.entries(Object.assign({ title, body, icon: '/icon-192.png' }, data))
        .map(([k, v]) => [k, String(v)])
    );
    const message = {
      token: fcmToken,
      data: stringData,
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' },
        notification: {
          title, body,
          icon: '/icon-192.png', badge: '/icon-192.png',
          vibrate: [200, 100, 200], requireInteraction: true,
          tag: stringData.type || 'bm-notification'
        },
        fcmOptions: { link: '/' }
      },
      android: {
        priority: 'high',
        ttl: 86400000,
        notification: {
          title, body,
          icon: 'notification_icon',
          color: '#2563eb',
          sound: 'default',
          channelId: 'attendance_alerts',
          priority: 'high',
          visibility: 'public',
          defaultVibrateTimings: true,
          defaultSound: true
        }
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            badge: 1,
            'content-available': 1,
            'mutable-content': 1
          }
        }
      }
    };
    const resp = await admin.messaging().send(message);
    console.log(`✅ [FCM-SINGLE] "${title}" → ${resp.substring(0, 20)}...`);
    return { ok: true, messageId: resp };
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
      return { ok: false, reason: 'invalid-token', code: e.code };
    }
    console.warn('⚠️ FCM send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

async function sendPushToMany(tokens, title, body, data = {}) {
  if (!fcmReady || !tokens || !tokens.length) return { ok: false, sent: 0, failed: 0 };
  const valid = tokens.filter(t => t && typeof t === 'string' && t.length > 20);
  if (!valid.length) return { ok: false, sent: 0, failed: 0 };
  try {
    const stringData = Object.fromEntries(
      Object.entries(Object.assign({ title, body, icon: '/icon-192.png' }, data))
        .map(([k, v]) => [k, String(v)])
    );
    const message = {
      tokens: valid,
      data: stringData,
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' },
        notification: {
          title, body,
          icon: '/icon-192.png', badge: '/icon-192.png',
          vibrate: [200, 100, 200], requireInteraction: true,
          tag: stringData.type || 'bm-notification'
        },
        fcmOptions: { link: '/' }
      },
      android: {
        priority: 'high',
        ttl: 86400000,
        notification: {
          title, body,
          icon: 'notification_icon',
          color: '#2563eb',
          sound: 'default',
          channelId: 'attendance_alerts',
          priority: 'high',
          visibility: 'public'
        }
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: { aps: { alert: { title, body }, sound: 'default', badge: 1 } }
      }
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
      try { await User.updateMany({ fcmToken: { $in: invalidTokens } }, { $set: { fcmToken: null } }); } catch (e) {}
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
  } catch (e) { return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

async function sendPushToRole(role, title, body, data = {}) {
  if (!fcmReady) return { ok: false, sent: 0, failed: 0, reason: 'fcm-not-ready' };
  try {
    const users = await User.find({ role, fcmToken: { $ne: null } }).select('fcmToken').lean();
    const tokens = users.map(u => u.fcmToken).filter(Boolean);
    if (!tokens.length) return { ok: false, sent: 0, failed: 0, reason: 'no-tokens' };
    return await sendPushToMany(tokens, title, body, data);
  } catch (e) { return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

async function sendPushToRollNo(rollNo, title, body, data = {}) {
  if (!fcmReady || !rollNo) return { ok: false };
  try {
    const u = await User.findOne({ rollNo: rollNo.toUpperCase() }).select('fcmToken').lean();
    if (!u || !u.fcmToken) return { ok: false, reason: 'no-token' };
    return await sendPushNotification(u.fcmToken, title, body, data);
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function sendPushToBranch(branch, title, body, data = {}) {
  if (!fcmReady) return { ok: false, sent: 0, failed: 0, reason: 'fcm-not-ready' };
  try {
    const users = await User.find({ role: 'student', branch, fcmToken: { $ne: null } }).select('fcmToken').lean();
    const tokens = users.map(u => u.fcmToken).filter(Boolean);
    if (!tokens.length) return { ok: false, sent: 0, failed: 0, reason: 'no-tokens' };
    return await sendPushToMany(tokens, title, body, data);
  } catch (e) { return { ok: false, sent: 0, failed: 0, reason: e.message }; }
}

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
//  AI PROVIDER CONFIG
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
    return models;
  } catch (e) { return []; }
}

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 100;
const COLLEGE_CLOSE_HOUR = 15;
const SEMESTER_START = new Date('2026-07-15T00:00:00+05:30');
const SEMESTER_END = new Date('2026-12-31T23:59:59+05:30');
const UNDO_WINDOW_MS = 5 * 60 * 1000;

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }

function getISTDateString(dateObj) { const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000)); return istDate.toISOString().split('T')[0]; }
function getISTHour(dateObj) { const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000)); return istDate.getUTCHours(); }
function getISTMinutes(dateObj) { const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000)); return istDate.getUTCHours() * 60 + istDate.getUTCMinutes(); }

function getBranchFromRoll(rollNo) {
  if (!rollNo) return null;
  const r = String(rollNo).trim().toUpperCase();
  if (/^24AIDS\d{2}$/.test(r)) return 'AIDS';
  if (/^24CSE\d{2}$/.test(r)) return 'CSE';
  return null;
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { error: 'Too many attempts.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 300, message: { error: 'Too many requests.' } });
app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

const registerSchema = z.object({ name: z.string().min(2).max(50), rollNo: z.string().min(3), password: z.string().min(6), deviceId: z.string().optional(), deviceName: z.string().optional(), role: z.enum(['student', 'faculty', 'admin']).default('student'), subject: z.string().optional().nullable() });
const loginSchema = z.object({ rollNo: z.string().min(1), password: z.string().min(1), deviceId: z.string().optional(), deviceName: z.string().optional() });

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
//  GAMIFICATION & ACHIEVEMENTS
// ============================================================
const ACHIEVEMENTS_DB = {
  'first_login': { title: 'Welcome Aboard!', desc: 'Logged in for the first time.', icon: '👋' },
  'streak_3': { title: 'On Fire!', desc: '3-day login streak.', icon: '🔥' },
  'streak_7': { title: 'Unstoppable', desc: '7-day login streak.', icon: '🚀' },
  'streak_30': { title: 'Legend', desc: '30-day login streak.', icon: '👑' },
  'attendance_1': { title: 'First Step', desc: 'Marked attendance for the first time.', icon: '✅' },
  'attendance_10': { title: 'Consistent', desc: 'Marked attendance 10 times.', icon: '📈' },
  'attendance_50': { title: 'Centurion', desc: 'Marked attendance 50 times.', icon: '💯' },
  'perfect_week': { title: 'Perfect Week', desc: '100% attendance in a single week.', icon: '🌟' }
};

async function unlockAchievement(rollNo, achievementId) {
  try {
    const exists = await Achievement.findOne({ rollNo, achievementId });
    if (exists) return;
    await Achievement.create({ rollNo, achievementId });
    const details = ACHIEVEMENTS_DB[achievementId];
    if (details) {
      sendPushToRollNo(rollNo, `🏆 Achievement Unlocked: ${details.title}`, details.desc, { type: 'achievement', achievementId }).catch(() => {});
    }
  } catch (e) { console.warn('Achievement error:', e.message); }
}

async function checkAndAwardAchievements(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return;

    const today = getISTDateString(new Date());
    const yesterday = getISTDateString(new Date(Date.now() - 86400000));

    if (user.lastLoginDate === today) {
      // already checked in today
    } else if (user.lastLoginDate === yesterday) {
      user.loginStreak = (user.loginStreak || 0) + 1;
    } else {
      user.loginStreak = 1;
    }
    user.lastLoginDate = today;

    if (user.loginStreak === 1) await unlockAchievement(rollNo, 'first_login');
    if (user.loginStreak >= 3) await unlockAchievement(rollNo, 'streak_3');
    if (user.loginStreak >= 7) await unlockAchievement(rollNo, 'streak_7');
    if (user.loginStreak >= 30) await unlockAchievement(rollNo, 'streak_30');

    const totalAttendance = await Attendance.countDocuments({ rollNo, status: 'Present' });
    if (totalAttendance >= 1) await unlockAchievement(rollNo, 'attendance_1');
    if (totalAttendance >= 10) await unlockAchievement(rollNo, 'attendance_10');
    if (totalAttendance >= 50) await unlockAchievement(rollNo, 'attendance_50');

    await user.save();
  } catch (e) { console.warn('checkAndAwardAchievements error:', e.message); }
}

function checkSubscription(user, requiredTier) {
  const tiers = { 'free': 0, 'silver': 1, 'gold': 2, 'platinum': 3 };
  const userTier = tiers[user.subscriptionTier || 'free'] || 0;
  const reqTier = tiers[requiredTier] || 0;
  
  if (userTier < reqTier) return false;
  if (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()) return false;
  return true;
}

// ============================================================
//  TIMETABLE
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
  Monday: [{ subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }, { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' }, { subject: 'LIB - Library', faculty: 'Library Staff' }, { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' }, { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }, { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' }, { subject: 'Sports', faculty: 'Sports Dept' }],
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
//  SCHEMAS
// ============================================================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, default: null },
  role: { type: String, enum: ['student', 'faculty', 'admin'], default: 'student' },
  boundDeviceId: { type: String, default: null },
  boundDeviceName: { type: String, default: null },
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
  dateOfBirth: { type: String, default: null },
  parentEmail: { type: String, default: null },
  parentPhone: { type: String, default: null },
  lastLoginIP: { type: String, default: null },
  lastLoginDevice: { type: String, default: null },
  lastLoginAt: { type: Date, default: null },
  feeStatus: { type: String, enum: ['Paid', 'Pending', 'Partial'], default: 'Paid' },
  feeDueDate: { type: String, default: null },
  feeAmount: { type: Number, default: 0 },
  
  subscriptionTier: { type: String, enum: ['free', 'silver', 'gold', 'platinum'], default: 'free' },
  subscriptionExpiresAt: { type: Date, default: null },
  loginStreak: { type: Number, default: 0 },
  lastLoginDate: { type: String, default: null },
  attendanceStreak: { type: Number, default: 0 },
  lastAttendanceDate: { type: String, default: null }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, required: true },
  subject: { type: String, required: true }, date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
  isVerified: { type: Boolean, default: false },
  branch: { type: String, default: 'CSE' },
  markedBy: { type: String, default: null },
  markedByRequestId: { type: String, default: null }
}, { timestamps: true });
attendanceSchema.index({ rollNo: 1, subject: 1, date: 1 }, { unique: true });
attendanceSchema.index({ markedByRequestId: 1 });

const holidaySchema = new mongoose.Schema({ date: { type: String, required: true, unique: true }, reason: { type: String, default: 'Holiday' } }, { timestamps: true });
const noticeSchema = new mongoose.Schema({ title: String, message: String, date: { type: Date, default: Date.now }, postedBy: String });

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
  reviewHistory: [{ action: { type: String, enum: ['Approved', 'Rejected', 'Undone'] }, by: String, at: { type: Date, default: Date.now }, note: { type: String, default: '' }, reviewedSubjects: [String] }]
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
  deviceName: { type: String, default: null },
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

const noteSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subject: { type: String, required: true },
  branch: { type: String, default: 'ALL' },
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, default: 0 },
  uploadedBy: { type: String, required: true },
  uploadedByName: { type: String, default: '' }
}, { timestamps: true });
noteSchema.index({ branch: 1, createdAt: -1 });

const notesFileSchema = new mongoose.Schema({
  noteId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, index: true },
  data: { type: Buffer, required: true },
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, default: 0 }
}, { timestamps: true });

const docRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, default: '' },
  title: { type: String, required: true },
  subject: { type: String, required: true },
  reason: { type: String, default: '' },
  branch: { type: String, default: 'CSE' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  adminNote: { type: String, default: '' }
}, { timestamps: true });
docRequestSchema.index({ status: 1, createdAt: -1 });

// NEW SCHEMAS
const achievementSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  achievementId: { type: String, required: true },
  unlockedAt: { type: Date, default: Date.now }
});
achievementSchema.index({ rollNo: 1, achievementId: 1 }, { unique: true });

const transactionSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String, default: null },
  amount: { type: Number, required: true },
  tier: { type: String, enum: ['silver', 'gold', 'platinum'], required: true },
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' }
}, { timestamps: true });

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
const Fee = mongoose.model('Fee', feeSchema);
const Assignment = mongoose.model('Assignment', assignmentSchema);
const Exam = mongoose.model('Exam', examSchema);
const LibraryBook = mongoose.model('LibraryBook', libraryBookSchema);
const Result = mongoose.model('Result', resultSchema);
const Announcement = mongoose.model('Announcement', announcementSchema);
const EmergencyAlert = mongoose.model('EmergencyAlert', emergencyAlertSchema);
const Note = mongoose.model('Note', noteSchema);
const NotesFile = mongoose.model('NotesFile', notesFileSchema);
const DocRequest = mongoose.model('DocRequest', docRequestSchema);
const Achievement = mongoose.model('Achievement', achievementSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

Attendance.createIndexes().catch(err => console.error('Index error:', err));

// ============================================================
//  BRANCH MIGRATION
// ============================================================
async function runBranchMigration() {
  try {
    console.log('🔧 [MIGRATION] Checking student branches...');
    const students = await User.find({ role: 'student' }).select('rollNo branch').lean();
    let fixed = 0;
    for (const s of students) {
      const correct = getBranchFromRoll(s.rollNo);
      if (correct && s.branch !== correct) {
        await User.updateOne({ _id: s._id }, { $set: { branch: correct } });
        console.log(`   🔧 Fixed ${s.rollNo}: ${s.branch} → ${correct}`);
        fixed++;
      }
    }
    if (fixed > 0) console.log(`✅ [MIGRATION] Fixed ${fixed} student(s)`);
    else console.log('✅ [MIGRATION] All branches OK');
  } catch (e) { console.warn('⚠️ [MIGRATION] Error:', e.message); }
}

// ============================================================
//  STUDENT SUMMARY
// ============================================================
async function getStudentSummary(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return null;
    const branch = getBranchFromRoll(rollNo) || user.branch || 'CSE';
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
      dayAcad[dayName] = [...new Set(acad.map(e => mapToCanonical(e.subject)))];
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
    return { totalAcademicLectures: totalAttended, totalConductedLectures: totalConducted, attendancePercentage: pct, subjectStats: subjectStatsFinal, daysPresent, workingDaysSoFar, totalWorkingDaysSemester, resolvedBranch: branch };
  } catch (e) { console.error('getStudentSummary error:', e); return null; }
}

async function getBunkAdvisor(rollNo) {
  const summary = await getStudentSummary(rollNo);
  if (!summary) return null;

  const { totalAcademicLectures: attended, totalConductedLectures: total, attendancePercentage: pct } = summary;
  const TARGET_PCT = 75;
  const target = TARGET_PCT / 100;

  const today = new Date();
  const semesterEnd = new Date('2026-12-31T23:59:59+05:30');
  const remainingWorkingDays = await getWorkingDays(today, semesterEnd);

  const user = await User.findOne({ rollNo }).select('branch').lean();
  const branch = getBranchFromRoll(rollNo) || (user && user.branch) || 'CSE';
  const avgLecturesPerDay = (branch === 'AIDS') ? 5.4 : 5.8;
  const remainingLectures = Math.round(remainingWorkingDays * avgLecturesPerDay);

  const totalSemesterLectures = total + remainingLectures;
  const maxAttended = attended + remainingLectures;
  const maxTotal = total + remainingLectures;
  const maxPossiblePct = maxTotal > 0 ? Math.round((maxAttended / maxTotal) * 100) : 0;
  const minPossiblePct = maxTotal > 0 ? Math.round((attended / maxTotal) * 100) : 0;

  let lecturesFor75 = 0;
  let canReach75 = false;
  if (pct >= 75) {
    canReach75 = true;
  } else {
    const x = Math.ceil((target * total - attended) / (1 - target));
    if (x <= remainingLectures) {
      lecturesFor75 = Math.max(0, x);
      canReach75 = true;
    }
  }

  const safeSkips = pct >= 75 ? Math.max(0, Math.floor((attended - target * total) / target)) : 0;

  let message = '';
  let status = '';
  let lecturesNeeded = 0;

  if (pct >= 75) {
    status = 'SAFE';
    lecturesNeeded = 0;
    message = `✅ Safe zone (${pct}%). You can skip ~${safeSkips} lecture(s) safely. Semester max possible: ${maxPossiblePct}%.`;
  } else if (canReach75) {
    status = 'DANGER';
    lecturesNeeded = lecturesFor75;
    message = `⚠️ You are at ${pct}% (${attended}/${total}). Attend ${lecturesFor75} more lecture(s) to reach 75%. Semester max possible: ${maxPossiblePct}%.`;
  } else {
    status = 'CRITICAL';
    lecturesNeeded = remainingLectures;
    message = `⚠️ You are at ${pct}% (${attended}/${total}). 75% is NOT achievable this semester. Attend ALL ${remainingLectures} remaining lectures to reach max possible ${maxPossiblePct}%.`;
  }

  return {
    totalAttended: attended,
    totalConducted: total,
    percentage: pct,
    canBunkLectures: safeSkips,
    lecturesNeeded,
    maxPossiblePct,
    minPossiblePct,
    remainingLectures,
    remainingWorkingDays,
    totalSemesterLectures,
    canReach75,
    status,
    message
  };
}

async function checkAttendanceMilestone(rollNo) {
  try {
    const summary = await getStudentSummary(rollNo);
    if (!summary) return;
    const pct = summary.attendancePercentage;
    if (pct >= 95) {
      sendPushToRollNo(rollNo, '🎉 Outstanding Attendance!', `Congrats! You crossed 95% (${summary.totalAcademicLectures}/${summary.totalConductedLectures}). Keep it up!`, { type: 'milestone', pct: '95' }).catch(() => {});
    } else if (pct >= 90) {
      sendPushToRollNo(rollNo, '🎉 Great Attendance!', `Excellent! You crossed 90% (${summary.totalAcademicLectures}/${summary.totalConductedLectures}).`, { type: 'milestone', pct: '90' }).catch(() => {});
    }
  } catch (e) {}
}

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
    try { return await callGroqOnce({ ...args, model, apiKey, attempt: 0 }); }
    catch (err) { lastError = err; }
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
      try { return await callGeminiOnce({ ...args, model, apiKey, attempt: i }); }
      catch (err) { lastError = err; const parsed = parseGeminiError(err); if (parsed.type === 'MODEL_NOT_FOUND') break; }
    }
  }
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
//  HEALTH & FCM ROUTES
// ============================================================
app.get('/', (req, res) => res.send('BM Group ERP Active!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: { primary: { provider: 'groq', model: GROQ_MODEL, keys: GROQ_API_KEYS.length }, fallback: { provider: 'gemini', model: GEMINI_MODEL, keys: GEMINI_API_KEYS.length, discovered: _geminiModelsCache.list.length } },
  fcm: { ready: fcmReady, projectId: process.env.FIREBASE_PROJECT_ID || null },
  version: '5.0',
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
    console.log(`📱 [FCM-SAVE] ${cr} → ${fcmToken.substring(0, 20)}...`);
    res.json({ message: 'FCM token saved', fcmReady });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/remove-fcm-token', async (req, res) => {
  try {
    const { rollNo } = req.body || {};
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    await User.updateOne({ rollNo: rollNo.trim().toUpperCase() }, { $set: { fcmToken: null } });
    res.json({ message: 'FCM token removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/send-notification', async (req, res) => {
  try {
    const { rollNo, title, body, data } = req.body || {};
    if (!rollNo || !title) return res.status(400).json({ error: 'rollNo and title required' });
    if (!fcmReady) return res.status(503).json({ error: 'FCM not configured on server' });
    const cr = String(rollNo).trim().toUpperCase();
    const result = await sendPushToRollNo(cr, title, body || '', data || {});
    if (result.ok) return res.json({ success: true, messageId: result.messageId });
    return res.json({ success: false, reason: result.reason || 'unknown' });
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

app.get('/api/admin/fix-branches/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const students = await User.find({ role: 'student' }).select('rollNo branch').lean();
    const fixes = [];
    for (const s of students) {
      const correct = getBranchFromRoll(s.rollNo);
      if (correct && s.branch !== correct) {
        await User.updateOne({ _id: s._id }, { $set: { branch: correct } });
        fixes.push({ rollNo: s.rollNo, from: s.branch, to: correct });
      }
    }
    res.json({ message: `Fixed ${fixes.length} student(s)`, fixes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  BULK DEVICE RESET
// ============================================================
app.post('/api/admin/bulk-reset-device', async (req, res) => {
  try {
    const { requesterRollNo, scope, rollNos } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    if (!scope || !['ALL', 'CSE', 'AIDS', 'SELECTED'].includes(scope)) {
      return res.status(400).json({ error: 'Invalid scope. Use ALL / CSE / AIDS / SELECTED.' });
    }

    let query = { role: 'student' };
    if (scope === 'CSE') query.branch = 'CSE';
    else if (scope === 'AIDS') query.branch = 'AIDS';
    else if (scope === 'SELECTED') {
      if (!Array.isArray(rollNos) || !rollNos.length) {
        return res.status(400).json({ error: 'rollNos required for SELECTED scope.' });
      }
      query.rollNo = { $in: rollNos.map(r => String(r).trim().toUpperCase()) };
    }

    const students = await User.find(query).select('rollNo name').lean();
    if (!students.length) return res.status(404).json({ error: 'No matching students found.' });

    const result = await User.updateMany(query, {
      $set: { boundDeviceId: null, boundDeviceName: null, activeSession: null }
    });

    for (const s of students) {
      sendPushToRollNo(s.rollNo, '📱 Device Reset', 'Your device binding was reset by admin. Please login again from any device.', { type: 'device_reset' }).catch(() => {});
    }

    console.log(`📱 [BULK RESET] ${result.modifiedCount} students reset (scope: ${scope})`);
    res.json({
      message: `Reset complete. ${result.modifiedCount} student(s) unlocked.`,
      resetCount: result.modifiedCount,
      students: students.map(s => s.rollNo)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  SUBSCRIPTION & PAYMENT ROUTES (NEW)
// ============================================================
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { rollNo, tier } = req.body;
    if (!rollNo || !tier) return res.status(400).json({ error: 'rollNo and tier required' });
    const user = await User.findOne({ rollNo: rollNo.toUpperCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const amounts = { silver: 4900, gold: 9900, platinum: 19900 }; // in paise (49, 99, 199 INR)
    const amount = amounts[tier];
    if (!amount) return res.status(400).json({ error: 'Invalid tier' });

    const options = {
      amount: amount,
      currency: "INR",
      receipt: `rcpt_${Date.now()}_${user.rollNo}`
    };
    const order = await razorpay.orders.create(options);

    await Transaction.create({
      rollNo: user.rollNo,
      orderId: order.id,
      amount: amount,
      tier: tier
    });

    res.json({ success: true, order, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret')
                                    .update(body.toString())
                                    .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      const txn = await Transaction.findOne({ orderId: razorpay_order_id });
      if (!txn) return res.status(404).json({ error: 'Transaction not found' });
      
      txn.status = 'paid';
      txn.paymentId = razorpay_payment_id;
      await txn.save();

      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 30); // 30 days validity

      const user = await User.findOneAndUpdate(
        { rollNo: txn.rollNo },
        { 
          subscriptionTier: txn.tier,
          subscriptionExpiresAt: expiryDate
        },
        { new: true }
      );

      sendPushToRollNo(user.rollNo, '🌟 Subscription Upgraded!', `You are now a ${txn.tier.toUpperCase()} member. Enjoy your premium features!`, { type: 'subscription_success' }).catch(()=>{});

      res.json({ success: true, message: 'Payment verified successfully', tier: txn.tier, expiry: expiryDate });
    } else {
      res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/subscription/:rollNo', async (req, res) => {
  try {
    const user = await User.findOne({ rollNo: req.params.rollNo.toUpperCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    let activeTier = user.subscriptionTier || 'free';
    let isExpired = false;
    if (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()) {
      isExpired = true;
      activeTier = 'free'; // Downgrade if expired
    }
    
    res.json({ tier: activeTier, expiresAt: user.subscriptionExpiresAt, isExpired });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  GAMIFICATION ROUTES (NEW)
// ============================================================
app.get('/api/student/achievements/:rollNo', async (req, res) => {
  try {
    const rollNo = req.params.rollNo.toUpperCase();
    const user = await User.findOne({ rollNo });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const unlocked = await Achievement.find({ rollNo }).lean();
    
    const result = unlocked.map(u => ({
      ...u,
      title: ACHIEVEMENTS_DB[u.achievementId]?.title || 'Unknown',
      desc: ACHIEVEMENTS_DB[u.achievementId]?.desc || '',
      icon: ACHIEVEMENTS_DB[u.achievementId]?.icon || '🏆'
    }));

    res.json({
      loginStreak: user.loginStreak || 0,
      attendanceStreak: user.attendanceStreak || 0,
      totalXp: (user.loginStreak * 10) + (result.length * 50), 
      unlockedAchievements: result
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  NOTES & DOCUMENTS (UPDATED: View & Download separated)
// ============================================================

app.get('/api/notes/:branch', async (req, res) => {
  try {
    const branch = (req.params.branch || 'CSE').toUpperCase();
    const notes = await Note.find({
      $or: [{ branch: 'ALL' }, { branch }]
    }).sort({ createdAt: -1 }).limit(100).lean();
    
    const result = notes.map(n => ({
      _id: n._id,
      title: n.title,
      subject: n.subject,
      branch: n.branch,
      fileName: n.fileName,
      mimeType: n.mimeType,
      size: n.size,
      uploadedBy: n.uploadedBy,
      uploadedByName: n.uploadedByName,
      createdAt: n.createdAt,
      viewUrl: `/api/notes/view/${n._id}`,      
      downloadUrl: `/api/notes/download/${n._id}` 
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notes/view/:noteId', async (req, res) => {
  try {
    const file = await NotesFile.findOne({ noteId: req.params.noteId });
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`);
    res.setHeader('Content-Length', file.data.length);
    res.send(file.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notes/download/:noteId', async (req, res) => {
  try {
    const file = await NotesFile.findOne({ noteId: req.params.noteId });
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
    res.setHeader('Content-Length', file.data.length);
    res.send(file.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notes/upload', async (req, res) => {
  try {
    const { requesterRollNo, title, subject, branch, fileBase64, fileName, mimeType } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    if (!title || !subject) return res.status(400).json({ error: 'title and subject are required.' });
    if (!fileBase64 || !fileName || !mimeType) return res.status(400).json({ error: 'File data required.' });

    let buffer;
    try { buffer = Buffer.from(fileBase64, 'base64'); }
    catch (e) { return res.status(400).json({ error: 'Invalid base64 file data.' }); }

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large. Max 10MB.' });
    }

    const finalBranch = (branch || 'ALL').toUpperCase();
    const note = await Note.create({
      title, subject,
      branch: finalBranch,
      fileName, mimeType, size: buffer.length,
      uploadedBy: user.rollNo, uploadedByName: user.name
    });

    await NotesFile.create({
      noteId: note._id,
      data: buffer,
      fileName, mimeType,
      size: buffer.length
    });

    const msg = `📚 New Note: ${title} — ${subject}`;
    if (finalBranch === 'ALL') {
      sendPushToAllStudents('📚 New Note Uploaded', msg, { type: 'note_added', noteId: note._id.toString() }).catch(() => {});
    } else {
      sendPushToBranch(finalBranch, '📚 New Note Uploaded', msg, { type: 'note_added', noteId: note._id.toString() }).catch(() => {});
    }

    res.status(201).json({
      message: 'Note uploaded successfully.',
      note: { _id: note._id, title, subject, branch: finalBranch, fileName }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/notes/:rollNo', async (req, res) => {
  try {
    const user = await User.findOne({ rollNo: req.params.rollNo.trim().toUpperCase() });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const notes = await Note.find({}).sort({ createdAt: -1 }).limit(200).lean();
    const result = notes.map(n => ({
      ...n,
      viewUrl: `/api/notes/view/${n._id}`,
      downloadUrl: `/api/notes/download/${n._id}`
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/notes/:id', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const user = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const note = await Note.findByIdAndDelete(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    await NotesFile.deleteOne({ noteId: note._id });
    res.json({ message: 'Note deleted successfully.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notes/request', async (req, res) => {
  try {
    const { rollNo, title, subject, reason, branch } = req.body;
    if (!rollNo || !title || !subject) return res.status(400).json({ error: 'rollNo, title, subject required.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found' });

    const docReq = await DocRequest.create({
      rollNo: cr, studentName: user.name,
      title, subject,
      reason: reason || '',
      branch: (branch || user.branch || 'CSE').toUpperCase(),
      status: 'Pending'
    });

    sendPushToRole('admin', '📤 Document Upload Request', `${user.name} (${cr}) — ${title} (${subject})`, { type: 'doc_request', requestId: docReq._id.toString() }).catch(() => {});
    res.status(201).json({ message: 'Request submitted. Admin will review shortly.', request: docReq });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/notes/requests/:rollNo', async (req, res) => {
  try {
    const user = await User.findOne({ rollNo: req.params.rollNo.trim().toUpperCase() });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const requests = await DocRequest.find({ status: 'Pending' }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(requests);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notes/requests/approve/:id', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const docReq = await DocRequest.findById(req.params.id);
    if (!docReq) return res.status(404).json({ error: 'Request not found' });
    if (docReq.status !== 'Pending') return res.status(400).json({ error: `Already ${docReq.status}.` });

    docReq.status = 'Approved';
    docReq.reviewedBy = adminUser.rollNo;
    docReq.reviewedAt = new Date();
    await docReq.save();

    sendPushToRollNo(docReq.rollNo, '✅ Document Request Fulfilled', `Your request for "${docReq.title}" (${docReq.subject}) has been completed.`, { type: 'doc_approved', requestId: docReq._id.toString() }).catch(() => {});
    res.json({ message: 'Request approved and student notified.', request: docReq });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notes/requests/reject/:id', async (req, res) => {
  try {
    const { requesterRollNo, note } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const docReq = await DocRequest.findById(req.params.id);
    if (!docReq) return res.status(404).json({ error: 'Request not found' });
    if (docReq.status !== 'Pending') return res.status(400).json({ error: `Already ${docReq.status}.` });

    docReq.status = 'Rejected';
    docReq.reviewedBy = adminUser.rollNo;
    docReq.reviewedAt = new Date();
    docReq.adminNote = note || '';
    await docReq.save();

    sendPushToRollNo(docReq.rollNo, '❌ Document Request Rejected', `Your request for "${docReq.title}" was rejected.`, { type: 'doc_rejected', requestId: docReq._id.toString() }).catch(() => {});
    res.json({ message: 'Request rejected.', request: docReq });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ANNOUNCEMENTS GET
// ============================================================
app.get('/api/announcements/:branch', async (req, res) => {
  try {
    const branch = (req.params.branch || 'CSE').toUpperCase();
    const announcements = await Announcement.find({
      $or: [{ branch: 'ALL' }, { branch }]
    }).sort({ createdAt: -1 }).limit(50).lean();
    res.json(announcements);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  FEE ENDPOINTS
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
    sendPushToRollNo(cr, '💰 New Fee Added', `₹${amount} due on ${dueDate}`, { type: 'fee_added', feeId: fee._id.toString() }).catch(() => {});
    res.status(201).json({ message: `Fee added for ${cr}`, fee });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/fees/:rollNo', async (req, res) => {
  try { res.json(await Fee.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ dueDate: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ASSIGNMENT / EXAM / LIBRARY / RESULT / ANNOUNCEMENT
// ============================================================
app.get('/api/assignments/:branch', async (req, res) => {
  try { res.json(await Assignment.find({ branch: req.params.branch.toUpperCase() }).sort({ dueDate: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/exams/:branch', async (req, res) => {
  try { res.json(await Exam.find({ branch: req.params.branch.toUpperCase() }).sort({ examDate: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AUTH ROUTES (UPDATED for Streaks)
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
    if (role === 'student') {
      const derived = getBranchFromRoll(cleanRoll);
      branch = derived || (cleanRoll.includes('AIDS') ? 'AIDS' : 'CSE');
    }
    const boundDeviceId = (role === 'student') ? (deviceId || null) : null;
    const newUser = new User({ name, rollNo: cleanRoll, password: hashedPassword, role, boundDeviceId, branch, facultySubject: (role === 'faculty') ? subject : null });
    await newUser.save();
    if (role === 'faculty' && subject) await TeacherSubject.create({ teacherRollNo: cleanRoll, subject: mapToCanonical(subject), assignedBy: cleanRoll });
    res.status(201).json({ message: `${role} ${name} Registered!`, rollNo: cleanRoll });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const { rollNo, password, deviceId, deviceName } = parsed.data;
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
    
    if (user.role === 'student') {
      const correctBranch = getBranchFromRoll(cleanRoll);
      if (correctBranch && user.branch !== correctBranch) user.branch = correctBranch;

      // STRICT DEVICE BINDING
      if (user.boundDeviceId && user.boundDeviceId !== deviceId) {
        return res.status(403).json({ error: '⛔ Unauthorized Device! You can only login from your registered phone. Please use "Reset Device" if you changed your phone.' });
      }
      
      if (!user.boundDeviceId && deviceId) {
        user.boundDeviceId = deviceId;
        user.boundDeviceName = deviceName || 'Unknown Device';
      } else if (user.boundDeviceId === deviceId && deviceName) {
        user.boundDeviceName = deviceName;
      }
    }

    user.lastLoginIP = req.ip;
    user.lastLoginDevice = deviceId || 'unknown';
    user.lastLoginAt = new Date();
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token; await user.save();

    // GAMIFICATION: Check login streak
    if (user.role === 'student') {
      await checkAndAwardAchievements(user.rollNo);
    }

    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role: user.role, branch: user.branch, subscriptionTier: user.subscriptionTier } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// VERIFY SESSION
app.post('/api/auth/verify-session', async (req, res) => {
  try {
    const { rollNo, token } = req.body;
    if (!rollNo || !token) return res.status(400).json({ error: 'rollNo and token required' });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ sessionInvalid: true, error: 'Invalid or expired token.' });
    }

    if (decoded.impersonated) {
      return res.json({ valid: true, impersonated: true });
    }

    if (decoded.rollNo !== rollNo.trim().toUpperCase()) {
      return res.status(401).json({ sessionInvalid: true, error: 'Token does not match user.' });
    }

    const user = await User.findOne({ rollNo: decoded.rollNo });
    if (!user) return res.status(401).json({ sessionInvalid: true, error: 'User not found.' });

    if (user.activeSession !== token) {
      return res.status(401).json({ sessionInvalid: true, error: 'You were logged out because you signed in on another device.' });
    }

    res.json({ valid: true });
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

// ============================================================
//  PROFILE / ADMIN
// ============================================================
app.get('/api/student/profile/:rollNo', async (req, res) => {
  try {
    const user = await User.findOne({ rollNo: req.params.rollNo.trim().toUpperCase() }).select('-password -activeSession');
    if (!user) return res.status(404).json({ error: 'Not found!' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    user.boundDeviceId = null; user.boundDeviceName = null; user.activeSession = null; await user.save();
    sendPushToRollNo(targetRollNo, '📱 Device Reset', 'Your device binding was reset. You can login from a new phone.', { type: 'device_reset' }).catch(() => {});
    res.json({ message: `Reset for ${targetRollNo}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ATTENDANCE REQUESTS
// ============================================================
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
    const correctBranch = getBranchFromRoll(cr) || user.branch || 'CSE';
    const newReq = await AttendanceRequest({ rollNo: cr, studentName: user.name, branch: correctBranch, date, lectureType, subject: subject ? mapToCanonical(subject) : null, subjects: (subjects || []).map(mapToCanonical), period: period || null, reason: reason || `Attendance request (${isPast ? 'past date' : 'after 3 PM'})`, location: null, distanceFromCollege: null, locationVerified: false, isPastDate: isPast, status: 'Pending' });
    await newReq.save();
    sendPushToRole('admin', '📩 New Attendance Request', `${user.name} (${cr}) requested ${lectureType.replace('_',' ')} for ${date}`, { type: 'attendance_request', rollNo: cr }).catch(() => {});
    res.status(201).json({ message: `✅ Request submitted.`, request: newReq });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  LIVE MARKING (UPDATED for Streaks & Achievements)
// ============================================================
app.post('/api/attendance/mark-live', async (req, res) => {
  try {
    const { rollNo, latitude, longitude, passcode, type } = req.body;
    if (!rollNo || !passcode || !type) return res.status(400).json({ error: 'rollNo, passcode, type required.' });
    if (!['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const branch = getBranchFromRoll(cr) || user.branch || 'CSE';
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
      
      if (marked > 0) {
        await checkAndAwardAchievements(cr); // Gamification trigger
      }

      if (marked === 0) return res.status(400).json({ error: `Already marked.` });
      checkAttendanceMilestone(cr).catch(() => {});
      sendPushToRollNo(cr, '✅ Attendance Marked', `Full day attendance marked (${marked} lectures) · ${lc.distance}m from campus`, { type: 'attendance_marked', date: todayStr, lectureType: 'full_day' }).catch(() => {});
      return res.status(201).json({ message: `✅ ${marked} marked (${skipped} already). ${lc.distance}m.`, marked, skipped });
    }
    const period = getCurrentPeriod(branch);
    if (!period) return res.status(400).json({ error: '⏰ No active lecture.' });
    const activeSubj = mapToCanonical(period.subject);
    try { await Attendance.create({ rollNo: cr, studentName: user.name, subject: activeSubj, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); }
    catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    
    await checkAndAwardAchievements(cr); // Gamification trigger
    
    checkAttendanceMilestone(cr).catch(() => {});
    sendPushToRollNo(cr, '✅ Lecture Marked', `${activeSubj} attendance marked · ${lc.distance}m from campus`, { type: 'attendance_marked', date: todayStr, lectureType: 'single_lecture', subject: activeSubj }).catch(() => {});
    res.status(201).json({ message: `✅ ${activeSubj} marked. ${lc.distance}m.`, subject: activeSubj });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  REQUESTS VIEW/REVIEW
// ============================================================
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
      const b = getBranchFromRoll(request.rollNo) || request.branch || 'CSE';
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
        try {
          const exists = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date });
          if (!exists) {
            await Attendance.create({
              rollNo: request.rollNo,
              studentName: request.studentName,
              subject: sub,
              date: request.date,
              status: 'Present',
              location: null,
              ipAddress: 'request-approved',
              isVerified: false,
              branch: b,
              markedByRequestId: request._id.toString()
            });
            markedCount++;
            markedSubjects.push(sub);
          }
        } catch (e) { if (e.code !== 11000) console.warn(e.message); }
      }
      request.status = markedSubjects.length === subjectsToMark.length ? 'Approved' : 'Partially Approved';
      request.reviewedBy = req1.rollNo; request.adminNote = note || '';
      request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: markedSubjects });
      await request.save();
      sendPushToRollNo(request.rollNo, '✅ Attendance Request Approved', `${request.date} — ${markedCount} lecture(s) marked.`, { type: 'request_approved' }).catch(() => {});
      res.json({ message: `✅ Approved. ${markedCount} marked.`, request, markedCount, markedSubjects, totalRequested: subjectsToMark.length, undoWindowSeconds: 300 });
    } else {
      request.status = 'Rejected'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
      request.reviewHistory.push({ action: 'Rejected', by: req1.rollNo, at: new Date(), note: note || '' });
      await request.save();
      sendPushToRollNo(request.rollNo, '❌ Attendance Request Rejected', `${request.date}${note ? ' — ' + note : ''}`, { type: 'request_rejected' }).catch(() => {});
      res.json({ message: `❌ Rejected.`, request });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests/undo/:id', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const adminUser = await User.findOne({ rollNo: (requesterRollNo || '').trim().toUpperCase() });
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

    const request = await AttendanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    if (request.status !== 'Approved' && request.status !== 'Partially Approved') {
      return res.status(400).json({ error: `Cannot undo — current status is "${request.status}".` });
    }

    const elapsedMs = Date.now() - new Date(request.updatedAt).getTime();
    if (elapsedMs > UNDO_WINDOW_MS) {
      return res.status(400).json({ error: `Undo window expired (${Math.round(elapsedMs/60000)} min ago). Max ${UNDO_WINDOW_MS/60000} minutes.` });
    }

    const delResult = await Attendance.deleteMany({ markedByRequestId: request._id.toString() });

    request.status = 'Pending';
    request.reviewedBy = null;
    request.adminNote = '';
    request.reviewHistory.push({
      action: 'Undone',
      by: adminUser.rollNo,
      at: new Date(),
      note: `Approval undone — ${delResult.deletedCount} attendance record(s) removed.`
    });
    await request.save();

    sendPushToRollNo(request.rollNo, '↩️ Approval Revoked', `Your attendance request for ${request.date} has been reverted to Pending by admin.`, { type: 'request_undone' }).catch(() => {});

    console.log(`↩️ [UNDO] Request ${request._id} reverted by ${adminUser.rollNo} — ${delResult.deletedCount} records removed.`);
    res.json({
      message: `Approval undone. ${delResult.deletedCount} attendance record(s) removed.`,
      deletedCount: delResult.deletedCount,
      request
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PASSCODE TOGGLE / TEACHER SUBJECTS / PASSCODE GENERATE
// ============================================================
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
    const b = getBranchFromRoll(cs) || su.branch || 'CSE';
    await new Attendance({ rollNo: cs, studentName: su.name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: b, markedBy: cr }).save();
    checkAttendanceMilestone(cs).catch(() => {});
    await checkAndAwardAchievements(cs); // Gamification trigger
    sendPushToRollNo(cs, '✅ Marked Present', `${teacher.name} marked you present for ${subj}`, { type: 'faculty_mark', subject: subj, markedBy: teacher.name }).catch(() => {});
    res.status(201).json({ message: `✅ Marked ${su.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI CHAT (GATED)
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
      
      // FEATURE GATE: AI Chat requires Gold or Platinum
      if (userData && userData.role === 'student') {
        if (!checkSubscription(userData, 'gold')) {
          return res.status(403).json({ error: '🔒 AI Chatbot is a premium feature. Upgrade to Gold or Platinum to use it.', requiresSubscription: true });
        }
      }

      if (threadId) { try { existingChat = await Chat.findOne({ threadId, rollNo: cr }); } catch (e) {} }
    }
    const userRole = userData?.role || role || 'student';
    const userName = userData?.name || name || 'Guest';
    const userBranch = getBranchFromRoll(cr) || userData?.branch || branch || 'CSE';
    const effectiveThreadId = existingChat?.threadId || threadId || null;
    const tStart = Date.now();
    const thinkingCtx = { userMessage: message, userRole, flags: { languageDetected: null } };
    const sendJson = (obj) => { obj.thinking = buildThinkingSteps({ ...thinkingCtx, latencyMs: Date.now() - tStart }); return res.json(obj); };
    const userLang = detectLanguage(message || '');
    thinkingCtx.flags.languageDetected = userLang;

    // --- ALL AI LOGIC HERE ---
    // (Kept intact from previous full file to save space in explanation, but here is the full block)
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
        if (shouldEscape) { await clearPending(cr); }
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
            if (!lc.isInside) { await clearPending(cr); return sendJson({ reply: `❌ **Out of range** (${lc.distance}m away).\n\nYou must be within 100m of BM Group campus.\n\n• Move closer\n• Then say **"mark my attendance"** again`, threadId: effectiveThreadId, aiOk: true, usedDatabase: true, locationRejected: true }); }
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
            await checkAndAwardAchievements(cr);
            sendPushToRollNo(cr, '✅ Attendance Marked via Chat', `${lectureType === 'full_day' ? 'Full day' : 'Single lecture'} marked · ${lc.distance}m`, { type: 'chat_mark', lectureType }).catch(() => {});
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
      lines.push(`Branch: ${userBranch}`);
      lines.push(`---STRICT_TIMETABLE_TODAY---`);
      lines.push(getStrictTimetableResponse(todayStr, userBranch));
      if (userData.role === 'student') {
        const summary = await getStudentSummary(userData.rollNo);
        if (summary) { lines.push(`Attendance: ${summary.totalAcademicLectures}/${summary.totalConductedLectures} (${summary.attendancePercentage}%)`); const advisor = await getBunkAdvisor(userData.rollNo); if (advisor) lines.push(`Advisor: ${advisor.message}`); }
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
    try { const aiResult = await callAI({ prompt: message, systemPrompt, history: existingChat?.messages, maxTokens: 1200, temperature: 0.5, threadId: effectiveThreadId }); reply = aiResult.reply; provider = aiResult.provider; aiOk = true; thinkingCtx.provider = provider; }
    catch (err) { reply = err.message; }
    let newThreadId = threadId, newTitle = 'New Chat';
    if (cr !== 'guest' && aiOk) {
      if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); if (!existingChat.title || existingChat.title === 'New Chat') existingChat.title = message.substring(0, 50); await existingChat.save(); newThreadId = existingChat.threadId; newTitle = existingChat.title; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: message.substring(0, 50) || 'New Chat', messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; newTitle = nt.title; }
    }
    sendJson({ reply, threadId: newThreadId, title: newTitle, aiOk, provider });
  } catch (err) { res.status(500).json({ error: 'Internal error: ' + err.message }); }
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
    if (cr !== 'guest') {
      userData = await User.findOne({ rollNo: cr });
      if (userData && userData.role === 'student' && !checkSubscription(userData, 'gold')) {
        return res.status(403).json({ error: '🔒 AI File Analysis requires Gold+ tier.' });
      }
    }
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
    
    if (requester.role === 'student' && !checkSubscription(requester, 'silver')) {
      return res.status(403).json({ error: '🔒 PDF Reports are a Silver+ feature. Please upgrade.', requiresSubscription: true });
    }

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
      pdfBuffer = await generatePDFBuffer({ title: 'Student Attendance Report', subtitle: `${targetUser.name} (${target}) • ${summary.resolvedBranch}`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${target}.pdf`);
      return res.send(pdfBuffer);
    }
    if (reportType === 'admin-defaulters') {
      const threshold = parseInt(req.body.threshold) || 75;
      const students = await User.find({ role: 'student' }).select('rollNo name branch').lean();
      const defaulters = [];
      for (const s of students) { const summary = await getStudentSummary(s.rollNo); if (summary && summary.attendancePercentage < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: summary.resolvedBranch, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  CRON JOBS
// ============================================================
const _cronFlags = { dailySummary: null, shortageWeekly: null, weeklyReport: null, monthlyProgress: null, birthday: null, pendingAdmin: null, pendingStudent: null, systemHealth: null };
function MONTH_NAME(m) { return ['January','February','March','April','May','June','July','August','September','October','November','December'][m]; }

let _lastReminderDate = null;
function scheduleAttendanceReminder() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const istHour = getISTHour(now); const istMin = getISTMinutes(now);
      const todayStr = getISTDateString(now);
      const day = now.getDay();
      if (day === 0 || day === 6) return;
      const inWindow = (istHour === 14 && istMin >= 45 && istMin <= 55);
      if (!inWindow) return;
      if (_lastReminderDate === todayStr) return;
      const hol = await Holiday.findOne({ date: todayStr });
      if (hol) { _lastReminderDate = todayStr; return; }
      _lastReminderDate = todayStr;
      await sendPushToAllStudents('⏰ Attendance Reminder', 'Live attendance window closes at 3 PM. Mark your attendance now!', { type: 'attendance_reminder', date: todayStr });
    } catch (e) {}
  }, 60 * 1000);
}
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
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo name branch fcmToken').lean();
      for (const s of students) {
        try {
          const b = getBranchFromRoll(s.rollNo) || s.branch || 'CSE';
          const tt = getTimetableForBranch(b);
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day];
          const acad = [...new Set((tt[dayName] || []).filter(x => !x.subject.includes('LIB') && !x.subject.includes('Sports')).map(x => mapToCanonical(x.subject)))];
          const recs = await Attendance.find({ rollNo: s.rollNo, date: todayStr, status: { $in: ['Present', 'Duty Leave'] } }).lean();
          const pSet = new Set(recs.map(r => mapToCanonical(r.subject)));
          let pCount = 0; acad.forEach(sub => { if (pSet.has(sub)) pCount++; });
          const pct = acad.length > 0 ? Math.round((pCount / acad.length) * 100) : 0;
          const summary = await getStudentSummary(s.rollNo);
          const overallPct = summary ? summary.attendancePercentage : 0;
          await sendPushNotification(s.fcmToken, '📊 Today\'s Summary', `Today: ${pCount}/${acad.length} lectures (${pct}%). Overall: ${overallPct}%`, { type: 'daily_summary' });
        } catch (e) {}
      }
    } catch (e) {}
  }, 60 * 1000);
}
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
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo name fcmToken').lean();
      for (const s of students) {
        try {
          const summary = await getStudentSummary(s.rollNo);
          if (!summary) continue;
          if (summary.attendancePercentage < 75) { await sendPushNotification(s.fcmToken, '⚠️ Attendance Warning', `Your attendance is ${summary.attendancePercentage}% — below 75%!`, { type: 'shortage_alert' }); }
          else if (summary.attendancePercentage < 80) { await sendPushNotification(s.fcmToken, '⚡ Attendance Near Limit', `Your attendance is ${summary.attendancePercentage}% — stay above 75%!`, { type: 'shortage_warning' }); }
        } catch (e) {}
      }
    } catch (e) {}
  }, 60 * 1000);
}
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
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const weekAgoStr = getISTDateString(weekAgo);
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo fcmToken').lean();
      for (const s of students) {
        try {
          const recs = await Attendance.find({ rollNo: s.rollNo, date: { $gte: weekAgoStr, $lte: todayStr } }).lean();
          const present = recs.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
          const pct = recs.length > 0 ? Math.round((present / recs.length) * 100) : 0;
          await sendPushNotification(s.fcmToken, '📈 Weekly Report', `This week: ${present}/${recs.length} (${pct}%). Keep going!`, { type: 'weekly_report' });
        } catch (e) {}
      }
    } catch (e) {}
  }, 60 * 1000);
}
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
      const students = await User.find({ role: 'student', fcmToken: { $ne: null } }).select('rollNo fcmToken').lean();
      for (const s of students) {
        try {
          const summary = await getStudentSummary(s.rollNo);
          if (!summary) continue;
          const emoji = summary.attendancePercentage >= 75 ? '✅' : '⚠️';
          await sendPushNotification(s.fcmToken, `📊 ${MONTH_NAME(now.getMonth())} Summary`, `${emoji} Overall: ${summary.attendancePercentage}% (${summary.totalAcademicLectures}/${summary.totalConductedLectures})`, { type: 'monthly_progress' });
        } catch (e) {}
      }
    } catch (e) {}
  }, 60 * 1000);
}
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
    } catch (e) {}
  }, 60 * 1000);
}
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
      const docReqs = await DocRequest.countDocuments({ status: 'Pending', createdAt: { $lt: cutoff } });
      const total = pending + leaves + regs + docReqs;
      if (total > 0) await sendPushToRole('admin', '⏰ Pending Requests', `${total} request(s) pending for 24+ hours. Review needed.`, { type: 'pending_admin_reminder' });
    } catch (e) {}
  }, 60 * 1000);
}

function scheduleClassReminders() {
  setInterval(async () => {
    try {
      if (!fcmReady) return;
      const now = new Date();
      const day = now.getDay();
      if (day === 0 || day === 6) return;
      const istHour = getISTHour(now);
      const istMin = getISTMinutes(now);

      for (const branch of ['CSE', 'AIDS']) {
        const schedule = getScheduleForBranch(branch);
        const daySchedule = schedule[day] || [];
        
        for (const slot of daySchedule) {
          if (slot.period === 'LUNCH' || slot.subject.includes('Sports') || slot.subject.includes('LIB')) continue;
          
          const startMins = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);

          if (istMin === startMins - 10) {
            await sendPushToBranch(branch, `⏰ Class in 10 Mins!`, `${slot.subject} starts at ${slot.start}. Get ready!`, { type: 'class_reminder_student', subject: slot.subject });
          }

          if (istMin === startMins - 5) {
            const faculty = await User.find({ role: 'faculty', fcmToken: { $ne: null } }).lean();
            for (const f of faculty) {
              try {
                const teaches = await TeacherSubject.findOne({ teacherRollNo: f.rollNo, subject: mapToCanonical(slot.subject) });
                if (teaches) {
                  await sendPushNotification(f.fcmToken, '⏰ Class in 5 Mins', `${slot.subject} at ${slot.start} — ${slot.faculty}`, { type: 'class_reminder_faculty' });
                }
              } catch (e) {}
            }
          }
        }
      }
    } catch (e) { console.error('Class Reminder Error:', e.message); }
  }, 60 * 1000);
}

scheduleAttendanceReminder();
scheduleDailySummary();
scheduleShortageAlert();
scheduleWeeklyReport();
scheduleMonthlyProgress();
scheduleBirthdayWish();
scheduleClassReminders();
schedulePendingAdminReminder();

process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); process.exit(1); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Port ${PORT}`);
  console.log(`🤖 AI: Groq(${GROQ_API_KEYS.length} keys) → Gemini(${GEMINI_API_KEYS.length} keys)`);
  console.log(`🔥 FCM: ${fcmReady ? 'READY ✅' : 'DISABLED ⚠️'}`);
  console.log(`📦 Version: 5.0 (Subscriptions + Gamification)`);
  setTimeout(runBranchMigration, 3000);
});
