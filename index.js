const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const csv = require('csv-parser');
const { Readable } = require('stream');
const PDFDocument = require('pdfkit');
process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone: ${process.env.TZ}`);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ============================================================
//  AI PROVIDER CONFIG — Groq Primary, Gemini Fallback
// ============================================================
// Groq API keys (primary — fast + reliable)
const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3
].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Gemini API keys (fallback — after 10 sec timeout on Groq)
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6
].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

// ✅ FIXED: Real, stable Gemini models (verified against Google official docs)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const GEMINI_GLOBAL_TIMEOUT_MS = parseInt(process.env.GEMINI_GLOBAL_TIMEOUT_MS || '20000', 10);

let groqKeyIndex = 0;
let geminiKeyIndex = 0;

function getNextGroqKey() {
  if (GROQ_API_KEYS.length === 0) return null;
  const key = GROQ_API_KEYS[groqKeyIndex % GROQ_API_KEYS.length];
  groqKeyIndex = (groqKeyIndex + 1) % GROQ_API_KEYS.length;
  return key;
}
function getNextGeminiKey() {
  if (GEMINI_API_KEYS.length === 0) return null;
  const key = GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length];
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
  return key;
}

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 100;
const COLLEGE_CLOSE_HOUR = 15; // 3 PM
const SEMESTER_START = new Date('2026-07-15T00:00:00+05:30');
const SEMESTER_END = new Date('2026-12-31T23:59:59+05:30');

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }
console.log(`🔑 Groq keys: ${GROQ_API_KEYS.length} | Gemini keys: ${GEMINI_API_KEYS.length}`);
console.log(`🤖 Primary AI: Groq (${GROQ_MODEL}) → Fallback after 10s: Gemini (${GEMINI_MODEL})`);

function getISTDateString(dateObj) {
  const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000));
  return istDate.toISOString().split('T')[0];
}
function getISTHour(dateObj) {
  const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000));
  return istDate.getUTCHours();
}
function getISTMinutes(dateObj) {
  const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000));
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: 'Too many requests.' } });
app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

const registerSchema = z.object({
  name: z.string().min(2).max(50),
  rollNo: z.string().min(3),
  password: z.string().min(6),
  deviceId: z.string().optional(),
  role: z.enum(['student', 'faculty', 'admin']).default('student'),
  subject: z.string().optional().nullable()
});
const loginSchema = z.object({
  rollNo: z.string().min(1),
  password: z.string().min(1),
  deviceId: z.string().optional()
});

function normalizeSubject(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }

const SUBJECT_ALIAS_MAP = {
  'BDA - Big Data Analytics': 'BDA - Big Data Analytics',
  'ECO - Economics for Engineers': 'ECO - Economics for Engineers',
  'DAA - Design & Analysis of Algorithm': 'DAA - Design & Analysis of Algorithm',
  'FLA - Formal Language & Automata': 'FLA - Formal Language & Automata',
  'HRM - Human Resource Mgmt': 'HRM - Human Resource Mgmt',
  'CN - Computer Network': 'CN - Computer Network',
  'WT - Web Technology': 'WT - Web Technology',
  'CN LAB - Computer Network Lab': 'CN LAB - Computer Network Lab',
  'DAA LAB - Algorithm Lab': 'DAA LAB - Algorithm Lab',
  'WT LAB - Web Technology Lab': 'WT LAB - Web Technology Lab',
  'Internet Lab (Ms. Geeta)': 'Internet Lab (Ms. Geeta)',
  'PA - Predictive Analysis': 'PA - Predictive Analysis',
  'ML - Machine Learning': 'ML - Machine Learning',
  'PA LAB - Predictive Analysis Lab': 'PA LAB - Predictive Analysis Lab',
  'ML LAB - Machine Learning Lab': 'ML LAB - Machine Learning Lab',
  'BDA LAB - Big Data Analytics Lab': 'BDA LAB - Big Data Analytics Lab',
  'LIB - Library': 'LIB - Library', 'Sports': 'Sports',
  'BDA': 'BDA - Big Data Analytics', 'ECO': 'ECO - Economics for Engineers',
  'DAA': 'DAA - Design & Analysis of Algorithm', 'FLA': 'FLA - Formal Language & Automata',
  'HRM': 'HRM - Human Resource Mgmt', 'CN': 'CN - Computer Network', 'WT': 'WT - Web Technology',
  'CN LAB': 'CN LAB - Computer Network Lab', 'DAA LAB': 'DAA LAB - Algorithm Lab',
  'WT LAB': 'WT LAB - Web Technology Lab', 'Internet': 'Internet Lab (Ms. Geeta)',
  'Internet Lab': 'Internet Lab (Ms. Geeta)', 'PA': 'PA - Predictive Analysis',
  'ML': 'ML - Machine Learning', 'PA LAB': 'PA LAB - Predictive Analysis Lab',
  'ML LAB': 'ML LAB - Machine Learning Lab', 'BDA LAB': 'BDA LAB - Big Data Analytics Lab',
  'LIB': 'LIB - Library'
};

function mapToCanonical(subject) {
  if (!subject) return '';
  const normalized = normalizeSubject(subject);
  if (SUBJECT_ALIAS_MAP[normalized]) return SUBJECT_ALIAS_MAP[normalized];
  const sortedAliases = Object.keys(SUBJECT_ALIAS_MAP).sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) {
    if (normalized === alias) return SUBJECT_ALIAS_MAP[alias];
    if (normalized.startsWith(alias + ' ')) return SUBJECT_ALIAS_MAP[alias];
  }
  for (const alias of sortedAliases) if (normalized.includes(alias)) return SUBJECT_ALIAS_MAP[alias];
  return normalized;
}

// ============================================================
//  TIMETABLE DATA
// ============================================================
const CSE_TIME_TABLE = {
  Monday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Tuesday: [
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'Internet Lab (Ms. Geeta)', faculty: 'Ms. Geeta' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Wednesday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'Sports / Activity', faculty: 'Sports Dept' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'CN LAB - Computer Network Lab', faculty: 'Mr. Chhetrapal' }
  ],
  Thursday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'DAA LAB - Algorithm Lab', faculty: 'Ms. Rashmi' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }
  ],
  Friday: [
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'WT LAB - Web Technology Lab', faculty: 'Mr. Avish Yadav' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Saturday: [], Sunday: []
};

const AIDS_TIME_TABLE = {
  Monday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'LIB - Library', faculty: 'Library Staff' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Tuesday: [
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' }
  ],
  Wednesday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'Sports / Project', faculty: 'Sports Dept' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'PA LAB - Predictive Analysis Lab', faculty: 'Ms. Pooja' }
  ],
  Thursday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'ML LAB - Machine Learning Lab', faculty: 'Mr. Harsh' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }
  ],
  Friday: [
    { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' },
    { subject: 'LIB - Library', faculty: 'Library Staff' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'BDA LAB - Big Data Analytics Lab', faculty: 'Ms. Geeta' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Saturday: [], Sunday: []
};

const CSE_SCHEDULE = {
  1: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" },
    { start:"10:50", end:"11:35", subject:"DAA - Design & Analysis of Algorithm", period:"P3", faculty:"Ms. Rashmi" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" },
    { start:"13:50", end:"14:35", subject:"CN - Computer Network", period:"P7", faculty:"Mr. Chhetrapal" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }
  ],
  2: [
    { start:"09:20", end:"10:05", subject:"WT - Web Technology", period:"P1", faculty:"Mr. Avish Yadav" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" },
    { start:"10:50", end:"11:35", subject:"Internet Lab (Ms. Geeta)", period:"P3", faculty:"Ms. Geeta" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" },
    { start:"13:50", end:"14:35", subject:"BDA - Big Data Analytics", period:"P7", faculty:"Ms. Geeta" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }
  ],
  3: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" },
    { start:"11:35", end:"12:20", subject:"Sports / Activity", period:"P4", faculty:"Sports Dept" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"13:50", subject:"WT - Web Technology", period:"P6", faculty:"Mr. Avish Yadav" },
    { start:"13:50", end:"15:20", subject:"CN LAB - Computer Network Lab", period:"P7-P8", faculty:"Mr. Chhetrapal" }
  ],
  4: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" },
    { start:"10:05", end:"10:50", subject:"WT - Web Technology", period:"P2", faculty:"Mr. Avish Yadav" },
    { start:"10:50", end:"11:35", subject:"CN - Computer Network", period:"P3", faculty:"Mr. Chhetrapal" },
    { start:"11:35", end:"12:20", subject:"DAA - Design & Analysis of Algorithm", period:"P4", faculty:"Ms. Rashmi" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"14:35", subject:"DAA LAB - Algorithm Lab", period:"P6-P7", faculty:"Ms. Rashmi" },
    { start:"14:35", end:"15:20", subject:"HRM - Human Resource Mgmt", period:"P8", faculty:"Mr. Lokesh" }
  ],
  5: [
    { start:"09:20", end:"10:05", subject:"DAA - Design & Analysis of Algorithm", period:"P1", faculty:"Ms. Rashmi" },
    { start:"10:05", end:"10:50", subject:"CN - Computer Network", period:"P2", faculty:"Mr. Chhetrapal" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" },
    { start:"11:35", end:"12:20", subject:"BDA - Big Data Analytics", period:"P4", faculty:"Ms. Geeta" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"14:35", subject:"WT LAB - Web Technology Lab", period:"P6-P7", faculty:"Mr. Avish Yadav" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }
  ]
};

const AIDS_SCHEDULE = {
  1: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" },
    { start:"10:50", end:"11:35", subject:"LIB - Library", period:"P3", faculty:"Library Staff" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" },
    { start:"13:50", end:"14:35", subject:"PA - Predictive Analysis", period:"P7", faculty:"Ms. Pooja" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }
  ],
  2: [
    { start:"09:20", end:"10:05", subject:"WT - Web Technology", period:"P1", faculty:"Mr. Avish Yadav" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" },
    { start:"10:50", end:"11:35", subject:"PA - Predictive Analysis", period:"P3", faculty:"Ms. Pooja" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4", faculty:"Ms. Nisha Yadav" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6", faculty:"Mr. Lokesh" },
    { start:"13:50", end:"14:35", subject:"BDA - Big Data Analytics", period:"P7", faculty:"Ms. Geeta" },
    { start:"14:35", end:"15:20", subject:"ML - Machine Learning", period:"P8", faculty:"Mr. Harsh" }
  ],
  3: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2", faculty:"Ms. Sakshi Yadav" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" },
    { start:"11:35", end:"12:20", subject:"Sports / Project", period:"P4", faculty:"Sports Dept" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"13:50", subject:"WT - Web Technology", period:"P6", faculty:"Mr. Avish Yadav" },
    { start:"13:50", end:"15:20", subject:"PA LAB - Predictive Analysis Lab", period:"P7-P8", faculty:"Ms. Pooja" }
  ],
  4: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1", faculty:"Ms. Geeta" },
    { start:"10:05", end:"10:50", subject:"WT - Web Technology", period:"P2", faculty:"Mr. Avish Yadav" },
    { start:"10:50", end:"11:35", subject:"ML - Machine Learning", period:"P3", faculty:"Mr. Harsh" },
    { start:"11:35", end:"12:20", subject:"PA - Predictive Analysis", period:"P4", faculty:"Ms. Pooja" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"14:35", subject:"ML LAB - Machine Learning Lab", period:"P6-P7", faculty:"Mr. Harsh" },
    { start:"14:35", end:"15:20", subject:"HRM - Human Resource Mgmt", period:"P8", faculty:"Mr. Lokesh" }
  ],
  5: [
    { start:"09:20", end:"10:05", subject:"ML - Machine Learning", period:"P1", faculty:"Mr. Harsh" },
    { start:"10:05", end:"10:50", subject:"LIB - Library", period:"P2", faculty:"Library Staff" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3", faculty:"Ms. Nisha Yadav" },
    { start:"11:35", end:"12:20", subject:"BDA - Big Data Analytics", period:"P4", faculty:"Ms. Geeta" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH", faculty:"-" },
    { start:"13:05", end:"14:35", subject:"BDA LAB - Big Data Analytics Lab", period:"P6-P7", faculty:"Ms. Geeta" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8", faculty:"Sports Dept" }
  ]
};

function getTimetableForBranch(branch) {
  if (branch && branch.toUpperCase() === 'AIDS') return AIDS_TIME_TABLE;
  return CSE_TIME_TABLE;
}
function getScheduleForBranch(branch) {
  return (branch && branch.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE;
}
function getCurrentPeriod(branch = 'CSE') {
  const now = new Date();
  const day = now.getDay();
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
  if (dayName === 'Saturday' || dayName === 'Sunday') {
    return `📅 **${dayName} (${dateStr}) — College Closed**\nWeekend hai, koi classes nahi.`;
  }
  const schedule = getScheduleForDate(dateStr, branch);
  const slots = schedule.schedule.filter(s => s.period !== 'LUNCH');
  if (!slots.length) return `📅 ${dayName} (${dateStr}) — No classes scheduled.`;
  let txt = `📅 **${dayName} (${dateStr}) — ${branch} Timetable**\n\n`;
  slots.forEach((sl, i) => {
    const subj = mapToCanonical(sl.subject);
    const isLab = sl.period.includes('-');
    txt += `**${sl.period}** · ${sl.start}–${sl.end}\n  📚 ${subj}\n  👨‍🏫 ${sl.faculty}\n`;
    if (isLab) txt += `  _Lab (extended)_\n`;
    if (i < slots.length - 1) txt += `\n`;
  });
  return txt.trim();
}

// ============================================================
//  HELPERS
// ============================================================
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
function verifyLocationForRequest(lat, lng) {
  if (!lat || !lng || lat === 0 || lng === 0) {
    return { valid: false, distance: null, message: 'Location not provided. Please enable GPS and try again.' };
  }
  const d = calculateDistance(lat, lng, COLLEGE_LAT, COLLEGE_LNG);
  const dInt = Math.round(d);
  if (dInt > COLLEGE_RADIUS) {
    return { valid: false, distance: dInt, message: `You are ${dInt}m away from BM Group college. Attendance request can only be submitted within ${COLLEGE_RADIUS}m of the campus.` };
  }
  return { valid: true, distance: dInt, message: `Location verified — ${dInt}m from college (within ${COLLEGE_RADIUS}m limit). ✅` };
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
    'BDA - Big Data Analytics':'BDA','ECO - Economics for Engineers':'ECO',
    'DAA - Design & Analysis of Algorithm':'DAA','FLA - Formal Language & Automata':'FLA',
    'HRM - Human Resource Mgmt':'HRM','CN - Computer Network':'CN','WT - Web Technology':'WT',
    'Internet Lab (Ms. Geeta)':'INT','CN LAB - Computer Network Lab':'CNL',
    'DAA LAB - Algorithm Lab':'DAAL','WT LAB - Web Technology Lab':'WTL',
    'LIB - Library':'LIB','PA - Predictive Analysis':'PA','ML - Machine Learning':'ML',
    'PA LAB - Predictive Analysis Lab':'PAL','ML LAB - Machine Learning Lab':'MLL',
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
  lastAttendanceTime: { type: Date, default: null },
  lastAttendanceLocation: { latitude: Number, longitude: Number },
  failedAttempts: { type: Number, default: 0 },
  blockUntil: { type: Date, default: null },
  email: { type: String, default: null },
  profilePic: { type: String, default: null },
  semester: { type: String, default: '5th' },
  branch: { type: String, default: 'CSE' },
  activeSession: { type: String, default: null },
  facultySubject: { type: String, default: null }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
  isVerified: { type: Boolean, default: false },
  branch: { type: String, default: 'CSE' }
}, { timestamps: true });
attendanceSchema.index({ rollNo: 1, subject: 1, date: 1 }, { unique: true });

const holidaySchema = new mongoose.Schema({ date: { type: String, required: true, unique: true }, reason: { type: String, default: 'Holiday' } }, { timestamps: true });
const noticeSchema = new mongoose.Schema({ title: String, message: String, date: { type: Date, default: Date.now } });

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
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  branch: { type: String, default: 'CSE' },
  date: { type: String, required: true },
  lectureType: { type: String, enum: ['full_day', 'single_lecture', 'double_lecture'], required: true },
  subject: { type: String, default: null },
  subjects: [{ type: String }],
  period: { type: String, default: null },
  reason: { type: String, default: 'Manual attendance request from chat' },
  location: { latitude: Number, longitude: Number },
  distanceFromCollege: { type: Number, default: null },
  locationVerified: { type: Boolean, default: false },
  isPastDate: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Partially Approved'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  adminNote: { type: String, default: '' },
  reviewHistory: [{
    action: { type: String, enum: ['Approved', 'Rejected'] },
    by: String,
    at: { type: Date, default: Date.now },
    note: { type: String, default: '' },
    reviewedSubjects: [String]
  }]
}, { timestamps: true });

// ✅ NEW: Account Requests schema (forgot password, device reset)
const accountRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  type: { type: String, enum: ['forgot_password', 'device_reset'], required: true },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Used'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  adminNote: { type: String, default: '' }
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
Attendance.createIndexes().catch(err => console.error('Index error:', err));

// ============================================================
//  STUDENT SUMMARY
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
  const { totalAcademicLectures: attended, totalConductedLectures: total, attendancePercentage: pct, workingDaysSoFar, daysPresent } = summary;
  const target = 0.75;
  const requiredTotal = total > 0 ? Math.ceil(attended / target) : 0;
  const canBunkLectures = total > 0 ? Math.max(0, Math.floor((attended - target * total) / target)) : 0;
  const lecturesNeeded = pct >= 75 ? 0 : Math.max(0, Math.ceil(target * total - attended));
  const daysNeeded = workingDaysSoFar > 0 ? Math.max(0, Math.ceil(target * workingDaysSoFar - daysPresent)) : 0;
  return {
    totalAttended: attended, totalConducted: total, percentage: pct,
    daysPresent, workingDaysSoFar, canBunkLectures, lecturesNeeded, daysNeeded,
    status: pct >= 75 ? 'SAFE' : 'DANGER',
    message: pct >= 75
      ? `✅ You are at ${pct}%. You can safely bunk about ${canBunkLectures} lecture(s) and still stay at ≥75%.`
      : `⚠️ You are at ${pct}% — BELOW 75%. You need to attend ${lecturesNeeded} more lecture(s) to reach 75%.`
  };
}

// ============================================================
//  AI: GROQ (PRIMARY) — Fast + Reliable
// ============================================================
async function callGroq({ prompt, systemPrompt = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 10000, model = null, apiKey = null }) {
  const useKey = apiKey || getNextGroqKey();
  if (!useKey) throw new Error('No Groq API key available');
  const useModel = model || GROQ_MODEL;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (history && Array.isArray(history)) {
    for (const m of history.slice(-8)) {
      if (!m || !m.content) continue;
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${useKey}`
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: 0.95
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq ${response.status}: ${errText.substring(0, 300)}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty Groq response');
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ============================================================
//  AI: GEMINI (FALLBACK) — After Groq fails/timeouts
// ============================================================
function parseGeminiError(err) {
  const msg = err.message || String(err);
  if (msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate')) {
    return { code: 429, type: 'RATE_LIMIT', friendly: 'AI rate limit reached. Please try again in about 30 seconds.' };
  }
  if (msg.includes('503') || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('unavailable')) {
    return { code: 503, type: 'OVERLOADED', friendly: 'AI service is currently busy. Please try again in about 15 seconds.' };
  }
  if (msg.includes('504') || msg.toLowerCase().includes('deadline') || msg.toLowerCase().includes('aborted')) {
    return { code: 504, type: 'TIMEOUT', friendly: 'AI took too long to respond. Please try again shortly.' };
  }
  if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
    return { code: 404, type: 'MODEL_NOT_FOUND', friendly: 'Requested AI model is not available right now. Please try again later.' };
  }
  if (msg.includes('400') || msg.toLowerCase().includes('invalid')) {
    return { code: 400, type: 'BAD_REQUEST', friendly: 'The request could not be processed. Please check your input and try again.' };
  }
  return { code: 500, type: 'UNKNOWN', friendly: 'AI service encountered an unexpected error. Please try again shortly.' };
}

async function callGeminiOnce({ prompt, systemPrompt = null, fileBase64 = null, mimeType = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 20000, model = null, apiKey = null }) {
  const useKey = apiKey || getNextGeminiKey();
  if (!useKey) throw new Error('No Gemini API key available');
  const useModel = model || GEMINI_MODEL;
  const contents = [];
  if (history && Array.isArray(history)) {
    for (const m of history.slice(-8)) {
      if (!m || !m.content) continue;
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
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
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini ${response.status}: ${errText.substring(0, 300)}`);
    }
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim();
    if (!text) throw new Error('Empty Gemini response. finishReason: ' + (candidate?.finishReason || 'unknown'));
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function callGemini(args) {
  const modelsToTry = [args.model || GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  const totalKeys = GEMINI_API_KEYS.length;
  if (totalKeys === 0) throw new Error('No Gemini API key available');
  const perCallTimeout = args.globalTimeoutMs || GEMINI_GLOBAL_TIMEOUT_MS;
  const maxAttempts = args.maxAttempts || 12;
  const startTime = Date.now();
  let lastError = null;
  let attemptsMade = 0;
  let globalTimeoutHit = false;

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    const keysPerModel = 2; // 2 attempts per model
    let skipToNextModel = false;

    for (let attempt = 0; attempt < keysPerModel; attempt++) {
      if (Date.now() - startTime > perCallTimeout) { globalTimeoutHit = true; break; }
      if (attemptsMade >= maxAttempts) break;
      const apiKey = getNextGeminiKey();
      if (!apiKey) break;
      attemptsMade++;
      try {
        console.log(`🤖 [GEMINI] Trying model=${model} | attempt=${attempt + 1}`);
        return await callGeminiOnce({ ...args, model, apiKey });
      } catch (err) {
        lastError = err;
        const parsed = parseGeminiError(err);
        console.warn(`⚠️ [GEMINI ${parsed.code}] ${model} failed: ${err.message.substring(0, 150)}`);
        if (parsed.type === 'OVERLOADED' || parsed.type === 'TIMEOUT') { skipToNextModel = true; break; }
        if (parsed.type === 'RATE_LIMIT') { await new Promise(r => setTimeout(r, 500)); continue; }
        if (parsed.type === 'MODEL_NOT_FOUND' || parsed.type === 'BAD_REQUEST') { skipToNextModel = true; break; }
        continue;
      }
    }
    if (globalTimeoutHit) break;
    if (attemptsMade >= maxAttempts) break;
  }
  const parsed = parseGeminiError(lastError);
  const friendly = globalTimeoutHit ? 'AI took too long to respond. Please try again in about 30 seconds.' : parsed.friendly;
  const finalErr = new Error(friendly);
  finalErr.code = parsed.code;
  finalErr.type = parsed.type;
  throw finalErr;
}

// ============================================================
//  AI: UNIFIED CALLER — Groq → (10s timeout) → Gemini
// ============================================================
async function callAI(args) {
  const GROQ_TIMEOUT_MS = 10000; // 10 seconds — then fallback to Gemini
  let groqError = null;

  // ---- STEP 1: Try Groq (primary) ----
  if (GROQ_API_KEYS.length > 0) {
    const maxGroqAttempts = Math.min(GROQ_API_KEYS.length, 3);
    for (let attempt = 0; attempt < maxGroqAttempts; attempt++) {
      try {
        console.log(`🚀 [GROQ] Attempt ${attempt + 1}/${maxGroqAttempts} | model=${GROQ_MODEL}`);
        const reply = await callGroq({
          ...args,
          timeoutMs: GROQ_TIMEOUT_MS
        });
        console.log(`✅ [GROQ] Success in attempt ${attempt + 1}`);
        return { reply, provider: 'groq', model: GROQ_MODEL };
      } catch (err) {
        groqError = err;
        console.warn(`⚠️ [GROQ] Attempt ${attempt + 1} failed: ${err.message.substring(0, 150)}`);
        // Agar timeout/network error hai to Gemini pe turant switch karo
        if (err.name === 'AbortError' || err.message.includes('abort')) {
          console.log('⏱️ [GROQ] Timeout — switching to Gemini');
          break;
        }
        // Agar rate limit ya overload hai to thoda wait karke retry
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } else {
    console.warn('⚠️ [GROQ] No keys configured — going straight to Gemini');
  }

  // ---- STEP 2: Fallback to Gemini ----
  console.log(`🔄 [FALLBACK] Groq failed → trying Gemini (${GEMINI_MODEL})`);
  try {
    const reply = await callGemini(args);
    console.log(`✅ [GEMINI] Success`);
    return { reply, provider: 'gemini', model: GEMINI_MODEL };
  } catch (geminiError) {
    // Both failed — throw the more useful error
    const groqMsg = groqError ? `Groq: ${groqError.message.substring(0, 100)}` : 'Groq: not configured';
    const geminiMsg = `Gemini: ${geminiError.message.substring(0, 100)}`;
    throw new Error(`Both AI providers failed. ${groqMsg} | ${geminiMsg}`);
  }
}

// ============================================================
//  PDF HELPER
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
//  ROUTES
// ============================================================
app.get('/', (req, res) => res.send('BM Group ERP Active!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: {
    primary: { provider: 'groq', model: GROQ_MODEL, keys: GROQ_API_KEYS.length },
    fallback: { provider: 'gemini', model: GEMINI_MODEL, fallbacks: GEMINI_FALLBACK_MODELS, keys: GEMINI_API_KEYS.length }
  },
  timestamp: new Date().toISOString()
}));

// ========== AUTH ==========
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const { rollNo, password, deviceId } = parsed.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    user.failedAttempts = 0; user.blockUntil = null;
    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { user.boundDeviceId = deviceId; await user.save(); }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) return res.status(403).json({ error: 'Unauthorized device!' });
    }
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token; await user.save();
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
    if (doc) res.json({ valid: true });
    else res.status(400).json({ error: 'Invalid or expired.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ✅ NEW: Account endpoints ==========
app.post('/api/auth/forgot-password-request', async (req, res) => {
  try {
    const { rollNo, reason } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found' });
    const existing = await AccountRequest.findOne({ rollNo: cr, type: 'forgot_password', status: 'Pending' });
    if (existing) return res.status(400).json({ error: 'Already pending request' });
    await AccountRequest.create({ rollNo: cr, type: 'forgot_password', reason: reason || 'Forgot password' });
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
    const existing = await AccountRequest.findOne({ rollNo: cr, type: 'device_reset', status: 'Pending' });
    if (existing) return res.status(400).json({ error: 'Already pending' });
    await AccountRequest.create({ rollNo: cr, type: 'device_reset', reason: reason || 'Device reset' });
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
    if (!approved) return res.status(403).json({ error: 'No approved forgot-password request. Contact admin first.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
    await User.updateOne({ rollNo: cr }, { $set: { password: await bcrypt.hash(newPassword, 10) } });
    approved.status = 'Used'; await approved.save();
    res.json({ message: 'Password updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/account-requests/:adminRollNo', async (req, res) => {
  try {
    const admin = await User.findOne({ rollNo: req.params.adminRollNo.trim().toUpperCase() });
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const requests = await AccountRequest.find({}).sort({ createdAt: -1 }).limit(100);
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/account-requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note } = req.body;
    const admin = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const r = await AccountRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    r.status = action; r.reviewedBy = admin.rollNo; r.adminNote = note || '';
    await r.save();
    if (action === 'Approved' && r.type === 'device_reset') {
      await User.updateOne({ rollNo: r.rollNo }, { $set: { boundDeviceId: null } });
    }
    res.json({ message: `Request ${action}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PROFILE ==========
app.post('/api/student/profile', async (req, res) => {
  try {
    const { rollNo, email, phone, profilePic, semester, branch } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (profilePic) user.profilePic = profilePic;
    if (semester) user.semester = semester;
    if (branch) user.branch = branch;
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

// ============================================================
//  ATTENDANCE REQUEST — STRICT RULES
// ============================================================
app.post('/api/requests/submit', async (req, res) => {
  try {
    const { rollNo, date, lectureType, subject, subjects, period, reason, latitude, longitude } = req.body;
    if (!rollNo || !date || !lectureType) return res.status(400).json({ error: 'rollNo, date, lectureType required.' });
    if (!['full_day', 'single_lecture', 'double_lecture'].includes(lectureType)) return res.status(400).json({ error: 'Invalid lectureType.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const todayStr = getISTDateString(new Date());
    if (date > todayStr) {
      return res.status(400).json({ error: `🚫 Future date attendance request allowed nahi hai (${date}).` });
    }
    if (date === todayStr) {
      const istHour = getISTHour(new Date());
      if (istHour < COLLEGE_CLOSE_HOUR) {
        return res.status(400).json({ error: `⏰ Aaj ka attendance request sirf 3 PM ke baad bhej sakte ho.`, code: 'USE_LIVE_MARKING' });
      }
    }
    const ds = await checkDateStatus(date);
    if (ds.isBlocked) return res.status(400).json({ error: ds.type === 'WEEKEND' ? `College closed on ${ds.dayName}.` : `Holiday: ${ds.holiday || 'College closed'}.` });
    const locCheck = verifyLocationForRequest(latitude, longitude);
    if (!locCheck.valid) {
      return res.status(400).json({ error: locCheck.message, distance: locCheck.distance, locationVerified: false, code: 'LOCATION_FAILED' });
    }
    if (lectureType !== 'full_day' && !subject) {
      return res.status(400).json({ error: 'subject required for single_lecture or double_lecture.' });
    }
    const existing = await AttendanceRequest.findOne({ rollNo: cr, date, lectureType, status: 'Pending' });
    if (existing) return res.status(400).json({ error: `You already have a pending request for ${date}.`, existing });
    const isPast = date < todayStr;
    const newReq = await AttendanceRequest({
      rollNo: cr, studentName: user.name, branch: user.branch || 'CSE',
      date, lectureType,
      subject: subject ? mapToCanonical(subject) : null,
      subjects: (subjects || []).map(mapToCanonical),
      period: period || null,
      reason: reason || `Attendance request (${isPast ? 'past date' : 'after 3 PM'})`,
      location: { latitude, longitude },
      distanceFromCollege: locCheck.distance,
      locationVerified: true, isPastDate: isPast, status: 'Pending'
    });
    await newReq.save();
    res.status(201).json({
      message: `✅ Request submitted. Location verified (${locCheck.distance}m). Admin review pending.`,
      request: newReq, locationVerified: true, distance: locCheck.distance
    });
  } catch (err) { console.error('Request submit error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  LIVE MARKING
// ============================================================
app.post('/api/attendance/mark-live', async (req, res) => {
  try {
    const { rollNo, latitude, longitude, passcode, type, subject } = req.body;
    if (!rollNo || !passcode || !type) return res.status(400).json({ error: 'rollNo, passcode, type required.' });
    if (!['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const branch = user.branch || 'CSE';
    const todayStr = getISTDateString(new Date());
    const ds = await checkDateStatus(todayStr);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const istHour = getISTHour(new Date());
    if (istHour >= COLLEGE_CLOSE_HOUR) {
      return res.status(400).json({ error: `⏰ College hours khatam ho gaye (3 PM ke baad).`, code: 'USE_REQUEST_FLOW' });
    }
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) {
      await incrementFailedAttempts(cr);
      return res.status(400).json({ error: `❌ Aap campus se ${lc.distance}m door ho. Sirf ${COLLEGE_RADIUS}m ke andar mark kar sakte ho.` });
    }
    const passDoc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() }, enabled: true });
    if (!passDoc) return res.status(400).json({ error: '❌ Invalid ya expired passcode.' });

    if (type === 'full_day') {
      const tt = getTimetableForBranch(branch);
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = days[new Date().getDay()];
      const allSubs = tt[dayName] || [];
      const acadSet = new Set();
      allSubs.forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Library") && !s.includes("Sports")) acadSet.add(s); });
      const acad = Array.from(acadSet);
      if (!acad.length) return res.status(400).json({ error: 'Aaj koi academic subject nahi hai.' });
      const existing = await Attendance.find({ rollNo: cr, date: todayStr, subject: { $in: acad } });
      const existSet = new Set(existing.map(r => mapToCanonical(r.subject)));
      let marked = 0, skipped = 0;
      const newAtt = [];
      for (const sub of acad) {
        if (!existSet.has(sub)) { newAtt.push({ rollNo: cr, studentName: user.name, subject: sub, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); marked++; }
        else skipped++;
      }
      if (newAtt.length) await Attendance.insertMany(newAtt, { ordered: false }).catch(err => { if (err.code !== 11000) throw err; });
      user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
      user.failedAttempts = 0; user.blockUntil = null;
      await user.save();
      if (marked === 0) return res.status(400).json({ error: `Already marked aaj ke saare ${skipped} lectures.` });
      return res.status(201).json({ message: `✅ ${marked} lectures marked (${skipped} pehle se the). Location verified (${lc.distance}m).`, marked, skipped, type: 'full_day' });
    }
    const period = getCurrentPeriod(branch);
    if (!period) return res.status(400).json({ error: '⏰ Abhi koi active lecture nahi hai.' });
    const activeSubj = mapToCanonical(period.subject);
    if (subject && mapToCanonical(subject) !== activeSubj) {
      return res.status(400).json({ error: `Active lecture "${activeSubj}" hai, aapne "${subject}" bheja.` });
    }
    try {
      await Attendance.create({ rollNo: cr, studentName: user.name, subject: activeSubj, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch });
    } catch (err) {
      if (err.code === 11000) return res.status(400).json({ error: `Already marked for ${activeSubj}.` });
      throw err;
    }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null;
    await user.save();
    res.status(201).json({ message: `✅ ${activeSubj} marked. Location verified (${lc.distance}m).`, subject: activeSubj, type: 'single_lecture' });
  } catch (err) { console.error('Live mark error:', err); res.status(500).json({ error: err.message }); }
});

// ========== REQUEST — STUDENT VIEW OWN ==========
app.get('/api/requests/my/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const requests = await AttendanceRequest.find({ rollNo: cr }).sort({ createdAt: -1 }).limit(50);
    res.json(requests);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const requests = await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ count: requests.length, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/requests/pending/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only.' });
    let filter = { status: 'Pending' };
    if (req1.role === 'faculty') filter.branch = req1.branch || 'CSE';
    const requests = await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ count: requests.length, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note, approvedSubjects } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only.' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Action must be Approved or Rejected.' });
    const request = await AttendanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (request.status !== 'Pending') return res.status(400).json({ error: `Request already ${request.status}.` });
    if (action === 'Approved') {
      const b = request.branch || 'CSE';
      const dateStatus = await checkDateStatus(request.date);
      if (dateStatus.isBlocked) return res.status(400).json({ error: `Cannot approve — date is blocked (${dateStatus.type}).` });
      const schedule = getScheduleForDate(request.date, b);
      let subjectsToMark = [];
      if (request.lectureType === 'full_day') {
        const daySubs = schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Library') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject));
        subjectsToMark = [...new Set(daySubs)];
      } else if (request.lectureType === 'single_lecture') {
        subjectsToMark = request.subject ? [mapToCanonical(request.subject)] : [];
      } else if (request.lectureType === 'double_lecture') {
        const subj = mapToCanonical(request.subject);
        const idx = schedule.schedule.findIndex(s => mapToCanonical(s.subject) === subj);
        if (idx >= 0) {
          subjectsToMark.push(subj);
          for (let i = idx + 1; i < schedule.schedule.length; i++) {
            const nextSub = mapToCanonical(schedule.schedule[i].subject);
            if (nextSub.includes('LIB') || nextSub.includes('Library') || nextSub.includes('Sports') || schedule.schedule[i].period === 'LUNCH') continue;
            subjectsToMark.push(nextSub);
            break;
          }
        } else subjectsToMark = [subj];
      }
      if (approvedSubjects && Array.isArray(approvedSubjects) && approvedSubjects.length > 0) {
        subjectsToMark = approvedSubjects.map(mapToCanonical);
      }
      let markedCount = 0;
      const markedSubjects = [];
      for (const sub of subjectsToMark) {
        try {
          const exists = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date });
          if (!exists) {
            await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: request.location, ipAddress: 'request-approved', isVerified: true, branch: b });
            markedCount++; markedSubjects.push(sub);
          }
        } catch (e) { if (e.code !== 11000) console.warn('Mark error:', e.message); }
      }
      request.status = markedSubjects.length === subjectsToMark.length ? 'Approved' : 'Partially Approved';
      request.reviewedBy = req1.rollNo;
      request.adminNote = note || '';
      request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: markedSubjects });
      await request.save();
      res.json({ message: `✅ Request approved. ${markedCount} lecture(s) marked.`, request, markedCount, markedSubjects, totalRequested: subjectsToMark.length });
    } else {
      request.status = 'Rejected';
      request.reviewedBy = req1.rollNo;
      request.adminNote = note || '';
      request.reviewHistory.push({ action: 'Rejected', by: req1.rollNo, at: new Date(), note: note || '' });
      await request.save();
      res.json({ message: `❌ Request rejected.`, request });
    }
  } catch (err) { console.error('Review error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/requests/bulk-review', async (req, res) => {
  try {
    const { requesterRollNo, requestIds, action, note } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    if (!Array.isArray(requestIds) || !requestIds.length) return res.status(400).json({ error: 'requestIds required.' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
    const results = [];
    let totalMarked = 0;
    for (const id of requestIds) {
      try {
        const request = await AttendanceRequest.findById(id);
        if (!request || request.status !== 'Pending') { results.push({ id, error: 'Not found or not pending' }); continue; }
        if (action === 'Rejected') {
          request.status = 'Rejected'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
          request.reviewHistory.push({ action: 'Rejected', by: req1.rollNo, at: new Date(), note: note || '' });
          await request.save();
          results.push({ id, status: 'Rejected' });
        } else {
          const b = request.branch || 'CSE';
          const schedule = getScheduleForDate(request.date, b);
          let subjectsToMark = [];
          if (request.lectureType === 'full_day') {
            subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Library') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
          } else if (request.lectureType === 'single_lecture' && request.subject) {
            subjectsToMark = [mapToCanonical(request.subject)];
          }
          let marked = 0;
          for (const sub of subjectsToMark) {
            try {
              const ex = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date });
              if (!ex) { await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: request.location, ipAddress: 'bulk-request-approve', isVerified: true, branch: b }); marked++; }
            } catch (e) {}
          }
          request.status = 'Approved'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
          request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: subjectsToMark });
          await request.save();
          totalMarked += marked;
          results.push({ id, status: 'Approved', marked });
        }
      } catch (e) { results.push({ id, error: e.message }); }
    }
    res.json({ message: `Bulk review complete. ${totalMarked} lectures marked.`, results });
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
    res.json({ message: `Passcode system ${enabled ? 'ENABLED' : 'DISABLED'}.`, enabled });
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
  try {
    const assignments = await TeacherSubject.find({ teacherRollNo: req.params.rollNo.trim().toUpperCase() });
    res.json(assignments.map(a => mapToCanonical(a.subject)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/teacher/students/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cr, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Teacher not found!' });
    const subjects = await TeacherSubject.find({ teacherRollNo: cr }).distinct('subject');
    if (!subjects.length) return res.json([]);
    const records = await Attendance.find({ subject: { $in: subjects } }).distinct('rollNo');
    const students = await User.find({ rollNo: { $in: records }, role: 'student' }).select('name rollNo');
    res.json(students);
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
    const total = records.length;
    const present = records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
    res.json({ average: total > 0 ? Math.round((present / total) * 100) : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/teacher/mark-attendance', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, studentRollNo } = req.body;
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
    await new Attendance({ rollNo: cs, studentName: su.name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: su.branch || 'CSE' }).save();
    res.status(201).json({ message: `✅ Marked ${su.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PASSCODE GENERATE ==========
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
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.type === 'WEEKEND' ? `📅 ${dateStatus.dayName}: College closed.` : `🎉 ${dateStatus.holiday || 'Holiday'}: College closed.`, blocked: true });
    const publishFlag = !!publish;
    const pubPublic = isPublic === undefined ? true : !!isPublic;

    if (type === 'single_lecture') {
      const branch = req1.branch || 'CSE';
      const period = getCurrentPeriod(branch);
      if (!period) return res.status(400).json({ error: 'No active lecture.' });
      const now = new Date();
      const ds = getISTDateString(now);
      const key = `single_lecture_${ds}_${period.start}`;
      if (force) { await Passcode.deleteMany({ key, type: 'single_lecture' }); }
      else { let doc = await Passcode.findOne({ key, type: 'single_lecture', enabled: true }); if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing', passcode: doc.passcode, type, expiresAt: doc.expiresAt, published: doc.published, isPublic: doc.isPublic }); }
      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const expiry = new Date(now.getTime() + 5 * 60 * 1000);
      await new Passcode({ passcode, type, key, expiresAt: expiry, published: publishFlag, isPublic: pubPublic, enabled: true, publishedAt: publishFlag ? now : null, publishedBy: publishFlag ? req1.rollNo : null, durationMinutes: publishFlag ? (parseInt(durationMinutes) || 5) : null }).save();
      await Passcode.deleteMany({ type: 'single_lecture', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : 'Generated', passcode, type, expiresAt: expiry, changed: !!force, published: publishFlag, isPublic: pubPublic });
    }
    if (type === 'full_day') {
      const now = new Date();
      const ds = getISTDateString(now);
      const key = `full_day_${ds}`;
      if (force) { await Passcode.deleteMany({ key, type: 'full_day' }); }
      else { let doc = await Passcode.findOne({ key, type: 'full_day', enabled: true }); if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing', passcode: doc.passcode, type, expiresAt: doc.expiresAt, published: doc.published, isPublic: doc.isPublic }); }
      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiry = new Date(now); expiry.setHours(23, 59, 59, 999);
      await new Passcode({ passcode, type, key, expiresAt: expiry, published: publishFlag, isPublic: pubPublic, enabled: true, publishedAt: publishFlag ? now : null, publishedBy: publishFlag ? req1.rollNo : null, durationMinutes: publishFlag ? (parseInt(durationMinutes) || 1440) : null }).save();
      await Passcode.deleteMany({ type: 'full_day', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : 'Generated', passcode, type, expiresAt: expiry, changed: !!force, published: publishFlag, isPublic: pubPublic });
    }
    res.status(400).json({ error: 'Invalid type' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/current-passcode/:type/:requesterRollNo', async (req, res) => {
  try {
    const { type, requesterRollNo } = req.params;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'Not found' });
    if (req1.role !== 'admin' && req1.role !== 'faculty') return res.status(403).json({ error: 'Access Denied' });
    if (type !== 'single_lecture') return res.status(400).json({ error: 'Only single_lecture supported' });
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
    if (!doc) return res.json({ passcode: null, message: 'No published passcode active.' });
    res.json({ passcode: doc.passcode, type, expiresAt: doc.expiresAt, durationMinutes: doc.durationMinutes, publishedAt: doc.publishedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEGACY MARKING ==========
app.post('/api/attendance/mark-lecture', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, passcode } = req.body;
    if (!rollNo || !subject || !passcode) return res.status(400).json({ error: 'Missing fields' });
    const todayDate = getISTDateString(new Date());
    const ds = await checkDateStatus(todayDate);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const cr = rollNo.trim().toUpperCase();
    const bc = await checkStudentBlocked(cr);
    if (bc.blocked) return res.status(403).json({ error: bc.message });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const period = getCurrentPeriod(user.branch || 'CSE');
    if (!period) return res.status(400).json({ error: 'No active period.' });
    const ns = mapToCanonical(subject), nc = mapToCanonical(period.subject);
    if (ns !== nc) return res.status(400).json({ error: 'Subject mismatch.' });
    const key = `single_lecture_${todayDate}_${period.start}`;
    const doc = await Passcode.findOne({ key, type: 'single_lecture', passcode, expiresAt: { $gt: new Date() }, enabled: true });
    if (!doc) return res.status(400).json({ error: 'Invalid/expired passcode.' });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `Outside (${lc.distance}m)` }); }
    try { await new Attendance({ rollNo: cr, studentName: user.name, subject: ns, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: user.branch || 'CSE' }).save(); }
    catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null;
    await user.save();
    res.status(201).json({ message: `✅ Marked for ${subject}!` });
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
    const allSubs = tt[dayName] || [];
    const acadSet = new Set();
    allSubs.forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Library") && !s.includes("Sports")) acadSet.add(s); });
    const acad = Array.from(acadSet);
    const existing = await Attendance.find({ rollNo: cr, date: todayDate, subject: { $in: acad } });
    const existSet = new Set(existing.map(r => mapToCanonical(r.subject)));
    let marked = 0, skipped = 0;
    const newAtt = [];
    for (const sub of acad) {
      if (!existSet.has(sub)) { newAtt.push({ rollNo: cr, studentName: name, subject: sub, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); marked++; }
      else skipped++;
    }
    if (newAtt.length > 0) await Attendance.insertMany(newAtt, { ordered: false }).catch(err => { if (err.code !== 11000) throw err; });
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null;
    await user.save();
    if (marked === 0 && skipped > 0) return res.status(400).json({ error: `All ${skipped} already marked today.` });
    if (marked === 0) return res.status(400).json({ error: 'No academic subjects today.' });
    res.status(201).json({ message: `✅ Marked ${marked} new (${skipped} already).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== NOTICES ==========
app.get('/api/notices', async (req, res) => {
  try { res.json(await Notice.find().sort({ date: -1 }).limit(10)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!message || message.trim() === "") { await Notice.deleteMany({}); return res.json({ message: 'Cleared!' }); }
    const nn = await new Notice({ title: title || 'Announcement', message }).save();
    res.status(201).json({ message: 'Published!', notice: nn });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HOLIDAYS ==========
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
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/holidays', async (req, res) => {
  try { res.json(await Holiday.find()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/date-status/:date', async (req, res) => {
  try { res.json(await checkDateStatus(req.params.date)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DASHBOARD ==========
app.get('/api/admin/dashboard-stats/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const totalStudents = await User.countDocuments({ role: 'student' });
    const todayDate = getISTDateString(new Date());
    const todayPresentStudents = await Attendance.distinct('rollNo', { date: todayDate, status: 'Present' });
    const todayPresent = todayPresentStudents.length;
    const pdetails = await Attendance.find({ date: todayDate, status: 'Present' }).select('rollNo studentName').lean();
    const uniq = {};
    pdetails.forEach(s => { if (!uniq[s.rollNo]) uniq[s.rollNo] = { rollNo: s.rollNo, name: s.studentName }; });
    const presentList = Object.values(uniq);
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
    res.json({ totalStudents, todayPresent, todayAbsent: absent.length, overallAttendance: totalAtt, overallPct, todayPresentStudents: presentList, workingDaysSoFar, totalWorkingDaysSemester, pendingRequests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/all-users/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await User.find().select('name rollNo role boundDeviceId email phone semester branch profilePic facultySubject').sort({ rollNo: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/faculty/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await User.find({ role: 'faculty' }).select('name rollNo email phone facultySubject').sort({ rollNo: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE VIEW ==========
app.get('/api/attendance/student/:rollNo/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1) return res.status(403).json({ error: 'Access Denied' });
    const isA = req1.role === 'admin', isT = req1.role === 'faculty';
    if (!isA && !isT) return res.status(403).json({ error: 'Access Denied' });
    const cr = req.params.rollNo.trim().toUpperCase();
    let records = await Attendance.find({ rollNo: cr }).sort({ date: -1 });
    if (isT) {
      const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject');
      records = records.filter(r => subs.includes(mapToCanonical(r.subject)));
    }
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
    if (isT) {
      const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject');
      if (!subs.includes(mapToCanonical(rec.subject))) return res.status(403).json({ error: 'Not authorized.' });
    }
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
    if (isT) {
      const subs = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject');
      if (!subs.includes(mapToCanonical(rec.subject))) return res.status(403).json({ error: 'Not authorized.' });
    }
    rec.status = status;
    await rec.save();
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
    if (isT) {
      const subs = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject');
      q.subject = { $in: subs };
    }
    const result = await Attendance.deleteMany(q);
    if (result.deletedCount === 0) return res.status(404).json({ error: 'No records.' });
    res.json({ message: `Deleted ${result.deletedCount}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== MONTHLY SUMMARY ==========
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
    const startStr = getISTDateString(startD), endStr = getISTDateString(endD);
    const records = await Attendance.find({ rollNo: cr, date: { $gte: startStr, $lte: endStr } }).lean();
    const subSet = new Set();
    let totalConducted = 0;
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const holidaySet = new Set((await Holiday.find({ date: { $gte: startStr, $lte: endStr } })).map(h => (h.date || '').toString().split('T')[0]));
    const todayStr = getISTDateString(new Date());
    let cur = new Date(startD);
    while (cur <= endD) {
      const ds = getISTDateString(cur);
      if (ds > todayStr) { cur.setDate(cur.getDate() + 1); continue; }
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
        const dayName = dayNameMap[dow];
        (tt[dayName] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) { subSet.add(sub); totalConducted++; } });
      }
      cur.setDate(cur.getDate() + 1);
    }
    const stats = {};
    subSet.forEach(sub => { stats[sub] = { total: 0, present: 0 }; });
    cur = new Date(startD);
    while (cur <= endD) {
      const ds = getISTDateString(cur);
      if (ds > todayStr) { cur.setDate(cur.getDate() + 1); continue; }
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
        const dayName = dayNameMap[dow];
        (tt[dayName] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (stats[sub]) stats[sub].total++; });
      }
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

// ========== MANUAL ATTENDANCE ==========
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
      toMark = (tt[dayName] || []).filter(e => !e.subject.includes("LIB") && !e.subject.includes("Library") && !e.subject.includes("Sports")).map(e => mapToCanonical(e.subject));
    }
    const uniq = [...new Set(toMark.map(s => mapToCanonical(s)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports')))];
    for (let sub of uniq) {
      const ex = await Attendance.findOne({ rollNo: tr, subject: sub, date });
      if (ex) { already.push(sub); continue; }
      await new Attendance({ rollNo: tr, studentName: user.name, subject: sub, date, status: status || 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'admin-manual', isVerified: true, branch: actualBranch }).save();
      marked++; markedSubs.push(sub);
    }
    let msg = `✅ Marked ${marked} for ${user.name} on ${date}`;
    if (already.length > 0) msg += `. Already: ${already.join(', ')}`;
    res.status(201).json({ message: msg, markedSubjects: markedSubs, alreadyMarked: already, total: marked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HISTORY / ALL ==========
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
    if (isT) {
      const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject');
      all = await Attendance.find({ subject: { $in: subs } }).sort({ rollNo: 1, date: -1 });
    } else all = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(all.map(r => { r.subject = mapToCanonical(r.subject); return r; }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== STUDENT SUMMARY ==========
app.get('/api/student/summary/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const summary = await getStudentSummary(cr);
    if (!summary) return res.status(500).json({ error: 'Failed to compute' });
    const daysAbsent = Math.max(0, summary.workingDaysSoFar - summary.daysPresent);
    res.json({
      totalAcademicLectures: summary.totalAcademicLectures,
      totalConductedLectures: summary.totalConductedLectures,
      attendancePercentage: summary.attendancePercentage,
      daysPresent: summary.daysPresent,
      daysAbsent,
      workingDaysSoFar: summary.workingDaysSoFar,
      totalWorkingDaysSemester: summary.totalWorkingDaysSemester,
      subjectStats: summary.subjectStats
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/bunk-advisor/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const advisor = await getBunkAdvisor(cr);
    if (!advisor) return res.status(500).json({ error: 'Failed to compute' });
    res.json(advisor);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== EXPORT ==========
app.get('/api/export/google-sheets/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const records = await Attendance.find().sort({ rollNo: 1, date: -1 });
    let csvOut = 'Roll No,Student Name,Subject,Date,Status,IP Address,Location\n';
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csvOut += `${r.rollNo},${r.studentName},${mapToCanonical(r.subject)},${r.date},${r.status},${r.ipAddress || 'N/A'},${loc}\n`;
    });
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
    if (isS && req1.rollNo !== cs) return res.status(403).json({ error: 'Only your own.' });
    const today = new Date();
    let sD, eD;
    if (range === 'CURRENT_MONTH') { sD = new Date(today.getFullYear(), today.getMonth(), 1); eD = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else if (range === 'SELECTED_MONTH') { const m = parseInt(month); if (isNaN(m) || m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' }); sD = new Date(2026, m, 1); eD = new Date(2026, m + 1, 0); }
    else { sD = new Date(SEMESTER_START); eD = new Date(SEMESTER_END); }
    if (eD > today) eD = today;
    const startStr = getISTDateString(sD), endStr = getISTDateString(eD);
    let records = await Attendance.find({ rollNo: cs, date: { $gte: startStr, $lte: endStr } }).sort({ date: 1 });
    if (isT) {
      const subs = await TeacherSubject.find({ teacherRollNo: rrn }).distinct('subject');
      records = records.filter(r => subs.includes(mapToCanonical(r.subject)));
    }
    if (records.length === 0) return res.status(404).json({ error: 'No records.' });
    const sName = records[0].studentName || 'Unknown';
    let csvOut = `Student Attendance Report\nStudent: ${sName} (${cs})\nRange: ${startStr} to ${endStr} (up to today)\nGenerated: ${new Date().toLocaleString()}\n\nDate,Subject,Status,Location,IP Address\n`;
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csvOut += `${r.date},${mapToCanonical(r.subject)},${r.status},${loc},${r.ipAddress || 'N/A'}\n`;
    });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csvOut += `\nTotal: ${total}, Present: ${present}, %: ${pct}%\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cs}_${range}.csv`);
    res.send(csvOut);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== SUBJECTS / TIMETABLE ==========
app.get('/api/timetable/subjects', async (req, res) => {
  try {
    const set = new Set();
    ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach(day => {
      CSE_TIME_TABLE[day].forEach(e => set.add(mapToCanonical(e.subject)));
      AIDS_TIME_TABLE[day].forEach(e => set.add(mapToCanonical(e.subject)));
    });
    res.json([...set].sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/timetable/full/:branch', async (req, res) => {
  try {
    const branch = (req.params.branch || 'CSE').toUpperCase();
    const tt = getTimetableForBranch(branch);
    const schedule = getScheduleForBranch(branch);
    res.json({ branch, timetable: tt, schedule });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/timetable/strict/:branch/:date', async (req, res) => {
  try {
    const branch = (req.params.branch || 'CSE').toUpperCase();
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const ds = await checkDateStatus(date);
    const text = getStrictTimetableResponse(date, branch);
    res.json({ branch, date, blocked: ds.isBlocked, type: ds.type || null, dayName: ds.dayName, formatted: text, schedule: ds.isBlocked ? [] : (getScheduleForDate(date, branch).schedule || []) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== CLASS REPORT ==========
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
        if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
          (tt[dayNameMap[dow]] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) totalCond++; });
        }
        cur.setDate(cur.getDate() + 1);
      }
      const pc = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: sStr, $lte: eStr }, status: { $in: ['Present', 'Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      return { rollNo: s.rollNo, name: s.name, branch: b, totalPresent: pc, totalLectures: totalCond, percentage: totalCond > 0 ? Math.round((pc / totalCond) * 100) : 0 };
    }));
    result.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));
    res.json({ students: result, totalLectures: result.length > 0 ? result[0].totalLectures : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== BULK MARK/DELETE ==========
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
    const results = [];
    let tMarked = 0, tSkipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE';
      const tt = getTimetableForBranch(b);
      let mk = 0, sk = 0;
      for (const date of dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        const dayName = ds.dayName;
        let toMark = subjects && subjects.length > 0 ? subjects : (tt[dayName] || []).map(x => mapToCanonical(x.subject));
        const uniq = [...new Set(toMark.filter(x => !x.includes('LIB') && !x.includes('Library') && !x.includes('Sports')))];
        for (const sub of uniq) {
          const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date });
          if (!ex) {
            try { await new Attendance({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'bulk-mark', isVerified: true, branch: b }).save(); mk++; }
            catch (err) { if (err.code === 11000) sk++; else throw err; }
          } else sk++;
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

// ========== CHAT ==========
app.get('/api/chats/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    res.json(await Chat.find({ rollNo: cr }).sort({ updatedAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/chats', async (req, res) => {
  try {
    const { rollNo, threadId, title, messages } = req.body;
    const cr = rollNo.trim().toUpperCase();
    if (!threadId) {
      const newTid = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const nc = new Chat({ rollNo: cr, threadId: newTid, title: title || 'New Chat', messages: messages || [] });
      await nc.save();
      return res.status(201).json(nc);
    } else {
      const chat = await Chat.findOne({ threadId, rollNo: cr });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (title) chat.title = title;
      if (messages) chat.messages = messages;
      chat.updatedAt = new Date();
      await chat.save();
      return res.json(chat);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/chats/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const { rollNo } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cr = rollNo.trim().toUpperCase();
    const result = await Chat.findOneAndDelete({ threadId, rollNo: cr });
    if (!result) return res.status(404).json({ error: 'Chat not found' });
    res.json({ message: 'Chat deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEAVE ==========
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
            if (sub.includes('LIB') || sub.includes('Library') || sub.includes('Sports')) continue;
            const ex = await Attendance.findOne({ rollNo: leave.rollNo, subject: sub, date: ds });
            if (!ex) await new Attendance({ rollNo: leave.rollNo, studentName: leave.studentName, subject: sub, date: ds, status: 'Duty Leave', isVerified: true, branch: b, ipAddress: 'leave-approved' }).save();
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    res.json({ message: `✅ Leave ${action.toLowerCase()} for ${leave.studentName}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DEFAULTERS ==========
app.get('/api/admin/defaulters/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const threshold = parseInt(req.query.threshold) || 75;
    const students = await User.find({ role: 'student' }).select('rollNo name branch');
    const today = getISTDateString(new Date());
    const startStr = getISTDateString(SEMESTER_START);
    const defaulters = [];
    for (const s of students) {
      const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      if (total === 0) { defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: 0, present: 0, total: 0 }); continue; }
      const pct = Math.round((present/total)*100);
      if (pct < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
    }
    defaulters.sort((a,b) => a.pct - b.pct);
    res.json({ threshold, defaulters });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  DB INTENT PROMPT
// ============================================================
const DB_INTENT_PROMPT = `You are the Database Intent Parser for BM Group ERP.
You translate user's natural language into a JSON operation. You NEVER invent data. You NEVER write prose.
## Today's date is provided in user context. Use it strictly.
## Collections: users, attendances, holidays, notices, leaves, passcodes, teachersubjects, attendancerequests
## Response JSON format (STRICT):
{"action":"reply"|"db_read"|"db_count"|"db_aggregate"|"db_top_attendance"|"db_create"|"db_update"|"db_delete"|"db_publish_passcode"|"db_toggle_passcode"|"db_submit_request"|"db_submit_request_needs_location"|"db_live_mark"|"db_review_request"|"db_bulk_review"|"db_bunk_advisor"|"db_timetable","collection":"...","filter":{...},"update":{...},"data":{...},"limit":number,"sort":{...},"explanation":"...","requiresConfirmation":true|false,"reply":null}
## CRITICAL RULES:
1. Students CANNOT directly create attendances. "attendance mark karo" → db_live_mark (before 3 PM) or db_submit_request_needs_location (after 3 PM/past)
2. TIMETABLE → action "db_timetable" with data: { date: "YYYY-MM-DD" }
3. BUNK ADVISOR → action "db_bunk_advisor"
4. TOP ATTENDANCE → action "db_top_attendance"
5. DEFAULTERS → action "db_aggregate" on attendances
6. PASSCODE TOGGLE → action "db_toggle_passcode"
7. PASSCODE PUBLISH → action "db_publish_passcode"
8. REQUESTS → action "db_read", collection "attendancerequests", filter {status:"Pending"}
9. Approve/Reject → action "db_review_request"
10. Bulk review → action "db_bulk_review"
11. Dates: kal = TOMORROW, aaj = TODAY, parso = day after tomorrow
12. Holidays create → db_create, holidays
13. Notices → db_create, notices
14. Non-DB chat → action "reply"
15. NO HALLUCINATION
Return ONLY valid JSON. No code fence. No extra text.`;

async function detectDbIntent(message, userContext) {
  const today = getISTDateString(new Date());
  const tomorrow = getISTDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const dayAfter = getISTDateString(new Date(Date.now() + 48 * 60 * 60 * 1000));
  const now = new Date();
  const istHour = getISTHour(now);
  const istMin = getISTMinutes(now);
  const istTimeStr = `${String(Math.floor(istMin/60)).padStart(2,'0')}:${String(istMin%60).padStart(2,'0')}`;
  const ctx = `Role: ${userContext.role}\nRollNo: ${userContext.rollNo}\nName: ${userContext.name}\nBranch: ${userContext.branch || 'CSE'}\nToday: ${today}\nTomorrow: ${tomorrow}\nDay after: ${dayAfter}\nCurrent IST: ${istTimeStr}\nCollege Hours: 09:20–15:00 IST`;
  const prompt = `${ctx}\n\nUser message: "${message}"\n\nReturn ONLY valid JSON.`;
  try {
    const reply = await callAI({ prompt, systemPrompt: DB_INTENT_PROMPT, maxTokens: 800, temperature: 0.1 });
    let cleaned = reply.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('DB intent parse failed:', err.message);
    return { action: 'reply', reply: null, explanation: 'Could not parse', requiresConfirmation: false };
  }
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

async function executeDbAction(intent, userContext, extra = {}) {
  const { action, collection, filter, update, data, limit, sort, explanation, reply } = intent;
  const isAdmin = userContext.role === 'admin';
  const isFaculty = userContext.role === 'faculty';
  const isStudent = userContext.role === 'student';
  const collMap = { users: User, attendances: Attendance, holidays: Holiday, notices: Notice, leaves: Leave, passcodes: Passcode, teachersubjects: TeacherSubject, attendancerequests: AttendanceRequest };

  if (action === 'reply') return { reply: reply || explanation || 'Noted.', isReply: true };

  if (action === 'db_timetable') {
    const date = data?.date || getISTDateString(new Date());
    const branch = userContext.branch || 'CSE';
    const text = getStrictTimetableResponse(date, branch);
    return { reply: text, isReply: true, strictTimetable: true };
  }

  if (action === 'db_bunk_advisor') {
    if (!isStudent) return { error: 'Only students can use bunk advisor.' };
    const advisor = await getBunkAdvisor(userContext.rollNo);
    if (!advisor) return { error: 'Student not found.' };
    let txt = `📊 **Bunk Advisor**\n\n📈 Overall: **${advisor.percentage}%** (${advisor.totalAttended}/${advisor.totalConducted})\n📅 Days Present: **${advisor.daysPresent}** / ${advisor.workingDaysSoFar}\n\n`;
    if (advisor.status === 'SAFE') txt += `✅ **SAFE** — can bunk **${advisor.canBunkLectures} lecture(s)** and stay ≥75%.`;
    else txt += `⚠️ **DANGER** — Need **${advisor.lecturesNeeded} lecture(s)** more to reach 75%.`;
    return { reply: txt, isReply: true, bunkAdvisor: advisor };
  }

  if (action === 'db_live_mark') {
    if (!isStudent) return { error: 'Only students can mark attendance.' };
    return { needsLiveMarking: true, data: data || {}, message: 'Please share location and passcode.', isLiveMarkRequired: true };
  }

  if (action === 'db_submit_request_needs_location') {
    if (!isStudent) return { error: 'Only students can submit attendance requests.' };
    return { needsLocation: true, requestData: data || {}, message: 'Please share location.', isLocationRequired: true };
  }

  if (isStudent) {
    if (['db_create', 'db_update', 'db_delete'].includes(action)) {
      if (collection !== 'attendancerequests') return { error: 'Students can only submit attendance requests.' };
    }
    if (['db_read', 'db_count', 'db_aggregate'].includes(action)) {
      if (collection === 'attendances' || collection === 'leaves' || collection === 'attendancerequests') { filter = filter || {}; filter.rollNo = userContext.rollNo; }
      if (collection === 'users') { filter = filter || {}; filter.rollNo = userContext.rollNo; }
      if (collection === 'passcodes') return { error: 'Passcodes are accessed via separate endpoint.' };
    }
    if (action === 'db_top_attendance') return { error: 'Only admin can view top attendance.' };
    if (action === 'db_toggle_passcode') return { error: 'Only admin can toggle passcodes.' };
    if (action === 'db_review_request' || action === 'db_bulk_review') return { error: 'Only admin/faculty can review requests.' };
  }

  if (isFaculty) {
    if (['users', 'notices', 'holidays', 'passcodes'].includes(collection) && ['db_create', 'db_update', 'db_delete'].includes(action)) return { error: 'Faculty cannot modify this collection.' };
    if (action === 'db_toggle_passcode') return { error: 'Only admin can toggle passcodes.' };
    if (action === 'db_top_attendance') return { error: 'Only admin can view top attendance.' };
  }

  try {
    const Model = collMap[collection];
    if (action === 'db_read') {
      if (!Model) return { error: 'Unknown collection' };
      let q = Model.find(filter || {});
      if (sort) q = q.sort(sort);
      q = q.limit(Math.min(limit || 20, 100));
      const docs = await q.lean();
      const sanitized = docs.map(d => { if (!isAdmin) { delete d.password; delete d.activeSession; delete d.boundDeviceId; } return d; });
      return { result: sanitized, count: sanitized.length };
    }
    if (action === 'db_count') { if (!Model) return { error: 'Unknown collection' }; const count = await Model.countDocuments(filter || {}); return { result: { count } }; }
    if (action === 'db_top_attendance') { if (!isAdmin) return { error: 'Admin only.' }; const lim = parseInt(data?.limit) || 5; const top = await getTopAttendance(lim); return { result: { top, limit: lim } }; }
    if (action === 'db_aggregate') {
      if (collection === 'attendances') {
        if (isAdmin && (!filter || !filter.rollNo)) {
          const students = await User.find({ role: 'student' }).select('rollNo name branch');
          const today = getISTDateString(new Date());
          const startStr = getISTDateString(SEMESTER_START);
          const defaulters = [];
          for (const s of students) {
            const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
            const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
            const pct = total > 0 ? Math.round((present/total)*100) : 0;
            if (total === 0 || pct < 75) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
          }
          defaulters.sort((a,b) => a.pct - b.pct);
          return { result: { totalDefaulters: defaulters.length, defaulters: defaulters.slice(0, 30) } };
        }
        const rollNo = (filter && filter.rollNo) || userContext.rollNo;
        const summary = await getStudentSummary(rollNo);
        if (!summary) return { error: 'Student not found' };
        return { result: { rollNo, attendancePercentage: summary.attendancePercentage, attended: summary.totalAcademicLectures, conducted: summary.totalConductedLectures, subjectStats: summary.subjectStats, workingDaysSoFar: summary.workingDaysSoFar, totalWorkingDaysSemester: summary.totalWorkingDaysSemester, daysPresent: summary.daysPresent } };
      }
      return { error: 'Aggregate only for attendances' };
    }
    if (action === 'db_create') {
      if (!Model) return { error: 'Unknown collection' };
      if (collection === 'holidays') { if (!isAdmin) return { error: 'Only admin can add holidays' }; if (!data || !data.date) return { error: 'Holiday date missing' }; await Holiday.findOneAndUpdate({ date: data.date }, { date: data.date, reason: data.reason || 'Holiday' }, { upsert: true }); return { result: { date: data.date, reason: data.reason } }; }
      if (collection === 'notices') { if (!isAdmin) return { error: 'Only admin can post notices' }; const n = await new Notice({ title: data.title || 'Announcement', message: data.message, date: new Date() }).save(); return { result: n.toObject() }; }
      if (collection === 'attendances') {
        if (!isAdmin) return { error: 'Admin only.' };
        if (!data || !data.rollNo || !data.subject || !data.date) return { error: 'Missing attendance fields' };
        const stu = await User.findOne({ rollNo: data.rollNo });
        if (!stu) return { error: 'Student not found' };
        try { const rec = await new Attendance({ rollNo: data.rollNo, studentName: stu.name, subject: mapToCanonical(data.subject), date: data.date, status: data.status || 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'chatbot-create', isVerified: true, branch: stu.branch || 'CSE' }).save(); return { result: rec.toObject() }; }
        catch (e) { if (e.code === 11000) return { error: 'Record already exists' }; throw e; }
      }
      return { error: 'Create not supported for: ' + collection };
    }
    if (action === 'db_update') { if (!Model) return { error: 'Unknown collection' }; if (!update) return { error: 'Update fields missing' }; const r = await Model.updateMany(filter || {}, update); return { result: { matched: r.matchedCount, modified: r.modifiedCount } }; }
    if (action === 'db_delete') { if (!Model) return { error: 'Unknown collection' }; if (collection === 'users' && !isAdmin) return { error: 'Only admin can delete users' }; const r = await Model.deleteMany(filter || {}); return { result: { deleted: r.deletedCount } }; }
    if (action === 'db_toggle_passcode') { if (!isAdmin) return { error: 'Only admin can toggle passcodes.' }; const enabled = data?.enabled === true; await Passcode.updateMany({}, { $set: { enabled } }); return { result: { enabled, message: `Passcode system ${enabled ? 'ENABLED' : 'DISABLED'}.` } }; }
    if (action === 'db_publish_passcode') {
      if (!isAdmin) return { error: 'Only admin can publish passcode' };
      const type = data?.type || 'single_lecture';
      const durationMinutes = parseInt(data?.durationMinutes) || (type === 'full_day' ? 1440 : 30);
      const pubPublic = data?.isPublic === undefined ? true : !!data.isPublic;
      const now = new Date();
      const todayStr = getISTDateString(now);
      const ds = await checkDateStatus(todayStr);
      if (ds.isBlocked) return { error: 'College closed today — no passcode needed.' };
      let passcode, expiry, key;
      if (type === 'single_lecture') { const period = getCurrentPeriod(userContext.branch || 'CSE'); if (!period) return { error: 'No active lecture now.' }; passcode = Math.floor(1000 + Math.random() * 9000).toString(); key = `single_lecture_${todayStr}_${period.start}_pub`; expiry = new Date(now.getTime() + durationMinutes * 60 * 1000); }
      else { passcode = Math.floor(10000 + Math.random() * 90000).toString(); key = `full_day_${todayStr}_pub`; expiry = new Date(now.getTime() + durationMinutes * 60 * 1000); }
      await Passcode.updateMany({ key }, { $set: { expiresAt: new Date(0) } });
      const doc = await new Passcode({ passcode, type, key, expiresAt: expiry, published: true, isPublic: pubPublic, enabled: true, publishedAt: now, publishedBy: userContext.rollNo, durationMinutes }).save();
      return { result: { passcode, type, expiresAt: expiry, durationMinutes, published: true, isPublic: pubPublic } };
    }
    if (action === 'db_review_request') {
      if (!isAdmin && !isFaculty) return { error: 'Only admin/faculty can review requests' };
      const { rollNo, date, requestId, action: reviewAction, note } = data || {};
      let reqDoc = null;
      if (requestId) reqDoc = await AttendanceRequest.findById(requestId);
      else if (rollNo && date) reqDoc = await AttendanceRequest.findOne({ rollNo: rollNo.toUpperCase(), date, status: 'Pending' }).sort({ createdAt: -1 });
      if (!reqDoc) return { error: 'No matching pending request found.' };
      const decision = reviewAction === 'Approved' ? 'Approved' : (reviewAction === 'Rejected' ? 'Rejected' : 'Approved');
      if (decision === 'Approved') {
        const b = reqDoc.branch || 'CSE';
        const schedule = getScheduleForDate(reqDoc.date, b);
        let subjectsToMark = [];
        if (reqDoc.lectureType === 'full_day') subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Library') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
        else if (reqDoc.lectureType === 'single_lecture' && reqDoc.subject) subjectsToMark = [mapToCanonical(reqDoc.subject)];
        else if (reqDoc.lectureType === 'double_lecture' && reqDoc.subject) { const subj = mapToCanonical(reqDoc.subject); const idx = schedule.schedule.findIndex(s => mapToCanonical(s.subject) === subj); if (idx >= 0) { subjectsToMark.push(subj); for (let i = idx + 1; i < schedule.schedule.length; i++) { const nxt = mapToCanonical(schedule.schedule[i].subject); if (nxt.includes('LIB') || nxt.includes('Library') || nxt.includes('Sports') || schedule.schedule[i].period === 'LUNCH') continue; subjectsToMark.push(nxt); break; } } else subjectsToMark = [subj]; }
        let marked = 0; const markedSubs = [];
        for (const sub of subjectsToMark) { try { const ex = await Attendance.findOne({ rollNo: reqDoc.rollNo, subject: sub, date: reqDoc.date }); if (!ex) { await Attendance.create({ rollNo: reqDoc.rollNo, studentName: reqDoc.studentName, subject: sub, date: reqDoc.date, status: 'Present', location: reqDoc.location, ipAddress: 'chatbot-review', isVerified: true, branch: b }); marked++; markedSubs.push(sub); } } catch (e) {} }
        reqDoc.status = marked === subjectsToMark.length ? 'Approved' : 'Partially Approved';
        reqDoc.reviewedBy = userContext.rollNo; reqDoc.adminNote = note || '';
        reqDoc.reviewHistory.push({ action: 'Approved', by: userContext.rollNo, at: new Date(), note: note || '', reviewedSubjects: markedSubs });
        await reqDoc.save();
        return { result: { requestId: reqDoc._id, status: reqDoc.status, marked, markedSubjects: markedSubs, totalRequested: subjectsToMark.length } };
      } else {
        reqDoc.status = 'Rejected'; reqDoc.reviewedBy = userContext.rollNo; reqDoc.adminNote = note || '';
        reqDoc.reviewHistory.push({ action: 'Rejected', by: userContext.rollNo, at: new Date(), note: note || '' });
        await reqDoc.save();
        return { result: { requestId: reqDoc._id, status: 'Rejected' } };
      }
    }
    if (action === 'db_bulk_review') {
      if (!isAdmin) return { error: 'Admin only.' };
      const decision = data?.action === 'Rejected' ? 'Rejected' : 'Approved';
      let ids = data?.requestIds || [];
      if (data?.selectAll) { const pending = await AttendanceRequest.find({ status: 'Pending' }).select('_id'); ids = pending.map(p => p._id.toString()); }
      if (!ids.length) return { error: 'No request IDs provided.' };
      let totalMarked = 0, processed = 0;
      for (const id of ids) {
        const r = await AttendanceRequest.findById(id);
        if (!r || r.status !== 'Pending') continue;
        processed++;
        if (decision === 'Rejected') { r.status = 'Rejected'; r.reviewedBy = userContext.rollNo; r.reviewHistory.push({ action: 'Rejected', by: userContext.rollNo, at: new Date() }); await r.save(); }
        else { const b = r.branch || 'CSE'; const schedule = getScheduleForDate(r.date, b); let subs = []; if (r.lectureType === 'full_day') subs = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Library') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))]; else if (r.subject) subs = [mapToCanonical(r.subject)]; let mk = 0; for (const sub of subs) { try { const ex = await Attendance.findOne({ rollNo: r.rollNo, subject: sub, date: r.date }); if (!ex) { await Attendance.create({ rollNo: r.rollNo, studentName: r.studentName, subject: sub, date: r.date, status: 'Present', location: r.location, ipAddress: 'bulk-review', isVerified: true, branch: b }); mk++; } } catch (e) {} } r.status = 'Approved'; r.reviewedBy = userContext.rollNo; r.reviewHistory.push({ action: 'Approved', by: userContext.rollNo, at: new Date(), reviewedSubjects: subs }); await r.save(); totalMarked += mk; }
      }
      return { result: { totalReviewed: processed, totalMarked, totalRequested: ids.length } };
    }
    return { error: 'Unsupported action: ' + action };
  } catch (err) { console.error('DB execute error:', err); return { error: 'Execution failed: ' + err.message }; }
}

function formatDbResult(result, action) {
  if (!result) return 'Done.';
  if (result.passcode) return `Passcode: **${result.passcode}**\nType: ${result.type}\nExpires: ${new Date(result.expiresAt).toLocaleString('en-IN')}\nPublic: ${result.isPublic ? 'Yes' : 'No'}`;
  if (result.enabled !== undefined && result.message) return result.message;
  if (result.top && Array.isArray(result.top)) { if (!result.top.length) return 'No attendance data yet.'; return result.top.map((r,i) => `${i+1}. **${r.rollNo}** (${r.name}) — ${r.pct}% (${r.present}/${r.total})`).join('\n'); }
  if (result.attendancePercentage !== undefined) { const weak = Object.entries(result.subjectStats || {}).filter(([_, s]) => s.percentage < 75); let txt = `Roll No: **${result.rollNo}**\nOverall: **${result.attendancePercentage}%** (${result.attended}/${result.conducted})\nWorking Days: ${result.workingDaysSoFar}/${result.totalWorkingDaysSemester}`; if (weak.length) txt += `\n\n⚠️ Low subjects (<75%):\n${weak.map(([s, st]) => `• ${s}: ${st.percentage}% (${st.present}/${st.total})`).join('\n')}`; return txt; }
  if (result.totalDefaulters !== undefined) { if (!result.totalDefaulters) return '✅ No defaulters below 75%!'; return `⚠️ **${result.totalDefaulters} defaulter(s):**\n${result.defaulters.map(d => `• ${d.rollNo} (${d.name}) — ${d.pct}% (${d.present}/${d.total})`).join('\n')}`; }
  if (result.requestId) return `Request ID: ${result.requestId}\nStatus: ${result.status}\nMarked: ${result.marked || 0}/${result.totalRequested || 0} lectures`;
  if (result.totalReviewed !== undefined) return `Reviewed: ${result.totalReviewed}\nMarked lectures: ${result.totalMarked}`;
  if (result.deleted !== undefined) return `Deleted: ${result.deleted}`;
  if (result.modified !== undefined) return `Modified: ${result.modified}`;
  if (result.count !== undefined) return `Count: ${result.count}`;
  if (Array.isArray(result)) { if (!result.length) return 'No records found.'; if (result[0] && result[0].lectureType !== undefined) return result.map(r => `• ${r.rollNo} (${r.studentName}) — ${r.date} — ${r.lectureType}${r.subject ? ' - ' + r.subject : ''} — ${r.status}`).join('\n'); return `${result.length} record(s):\n${result.slice(0, 10).map(r => JSON.stringify(r)).join('\n')}${result.length > 10 ? '\n...' : ''}`; }
  return JSON.stringify(result, null, 2);
}

// ============================================================
//  MAIN CHAT — Uses Groq primary → Gemini fallback
// ============================================================
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId, skipGreeting, useContext, useDatabase, location, passcode, markType, markSubject } = req.body;
    if (!message && !location) return res.status(400).json({ error: 'Message is required.' });
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

    if (useDb && userData) {
      try {
        const intent = await detectDbIntent(message || 'attendance mark karo', { role: userRole, rollNo: cr, name: userName, branch: userBranch });
        console.log('🧠 Intent:', JSON.stringify(intent).substring(0, 200));

        if (intent.action === 'db_live_mark') {
          if (location && location.latitude && location.longitude && passcode) {
            const lc = checkLocation(location.latitude, location.longitude);
            if (!lc.isInside) { const replyText = `❌ Aap campus se ${lc.distance}m door ho.`; return res.json({ reply: replyText, threadId, aiOk: true, usedDatabase: true, locationRejected: true, distance: lc.distance }); }
            const todayStr = getISTDateString(new Date());
            const ds = await checkDateStatus(todayStr);
            if (ds.isBlocked) return res.json({ reply: `❌ ${ds.message}`, threadId, aiOk: true, usedDatabase: true });
            const istHour = getISTHour(new Date());
            if (istHour >= COLLEGE_CLOSE_HOUR) return res.json({ reply: `⏰ College hours khatam (3 PM ke baad). Ab request bhejo.`, threadId, aiOk: true, usedDatabase: true });
            const type = markType || intent.data?.lectureType || 'full_day';
            const passDoc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() }, enabled: true });
            if (!passDoc) return res.json({ reply: `❌ Invalid ya expired passcode.`, threadId, aiOk: true, usedDatabase: true });
            if (type === 'full_day') {
              const tt = getTimetableForBranch(userBranch);
              const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const dayName = days[new Date().getDay()];
              const acadSet = new Set();
              (tt[dayName] || []).forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Library") && !s.includes("Sports")) acadSet.add(s); });
              const acad = Array.from(acadSet);
              if (!acad.length) return res.json({ reply: `Aaj koi academic subject nahi hai.`, threadId, aiOk: true, usedDatabase: true });
              let marked = 0, skipped = 0;
              for (const sub of acad) { try { await Attendance.create({ rollNo: cr, studentName: userName, subject: sub, date: todayStr, status: 'Present', location: { latitude: location.latitude, longitude: location.longitude }, ipAddress: req.ip, isVerified: true, branch: userBranch }); marked++; } catch (e) { if (e.code === 11000) skipped++; } }
              const replyText = `✅ **Full Day marked!**\n• Marked: ${marked} lectures${skipped ? `\n• Already: ${skipped}` : ''}\n• Location verified (${lc.distance}m)`;
              return res.json({ reply: replyText, threadId: existingChat?.threadId, title: existingChat?.title || 'Attendance', aiOk: true, usedDatabase: true, marked, skipped });
            } else {
              const period = getCurrentPeriod(userBranch);
              if (!period) return res.json({ reply: `⏰ Abhi koi active lecture nahi hai.`, threadId, aiOk: true, usedDatabase: true });
              const activeSubj = mapToCanonical(period.subject);
              try { await Attendance.create({ rollNo: cr, studentName: userName, subject: activeSubj, date: todayStr, status: 'Present', location: { latitude: location.latitude, longitude: location.longitude }, ipAddress: req.ip, isVerified: true, branch: userBranch }); } catch (e) { if (e.code === 11000) return res.json({ reply: `Already marked for ${activeSubj}.`, threadId, aiOk: true, usedDatabase: true }); }
              const replyText = `✅ **${activeSubj} marked!**\n• Location verified (${lc.distance}m)`;
              return res.json({ reply: replyText, threadId: existingChat?.threadId, title: existingChat?.title || 'Attendance', aiOk: true, usedDatabase: true });
            }
          }
          if (location && location.latitude && location.longitude && !passcode) {
            const lc = checkLocation(location.latitude, location.longitude);
            if (!lc.isInside) return res.json({ reply: `❌ Aap campus se ${lc.distance}m door ho.`, threadId, aiOk: true, usedDatabase: true, locationRejected: true, distance: lc.distance });
            const type = markType || intent.data?.lectureType || 'full_day';
            return res.json({ reply: `📍 Location verified (${lc.distance}m).\n\nAb **${type === 'full_day' ? '5-digit Full Day' : '4-digit Current Lecture'} passcode** daalo:`, threadId, aiOk: true, usedDatabase: true, needsPasscode: true, passcodeType: type, location: { latitude: location.latitude, longitude: location.longitude }, lectureType: type });
          }
          return res.json({ reply: `📍 **Live attendance marking**\n\nAap college hours me ho, isliye live mark hoga.\n\n**Step 1:** Share location\n**Step 2:** Daalo ${intent.data?.lectureType === 'single_lecture' ? '4-digit' : '5-digit'} passcode\n\nLocation share karo 👇`, threadId, title: 'Live Mark', aiOk: true, usedDatabase: true, needsLiveMarking: true, lectureType: intent.data?.lectureType || 'full_day', explanation: intent.explanation });
        }

        if (intent.action === 'db_submit_request_needs_location') {
          if (location && location.latitude && location.longitude) {
            const locCheck = verifyLocationForRequest(location.latitude, location.longitude);
            if (!locCheck.valid) { const replyText = `❌ ${locCheck.message}`; return res.json({ reply: replyText, threadId, aiOk: true, usedDatabase: true, dbError: locCheck.message, locationRejected: true, distance: locCheck.distance }); }
            const requestData = intent.data || {};
            const todayStr = getISTDateString(new Date());
            const reqDate = requestData.date || todayStr;
            const lectureType = requestData.lectureType || 'full_day';
            const subject = requestData.subject ? mapToCanonical(requestData.subject) : null;
            if (reqDate > todayStr) return res.json({ reply: `🚫 Future date ki request allowed nahi hai.`, threadId, aiOk: true, usedDatabase: true });
            if (reqDate === todayStr && getISTHour(new Date()) < COLLEGE_CLOSE_HOUR) return res.json({ reply: `⏰ Aaj ka request 3 PM ke baad bhej sakte ho.`, threadId, aiOk: true, usedDatabase: true });
            const ds = await checkDateStatus(reqDate);
            if (ds.isBlocked) return res.json({ reply: `❌ ${ds.message}`, threadId, aiOk: true, usedDatabase: true });
            const dup = await AttendanceRequest.findOne({ rollNo: cr, date: reqDate, lectureType, status: 'Pending' });
            if (dup) return res.json({ reply: `⚠️ Already pending request for ${reqDate}.`, threadId, aiOk: true, usedDatabase: true });
            const newReq = await AttendanceRequest.create({ rollNo: cr, studentName: userName, branch: userBranch, date: reqDate, lectureType, subject, subjects: [], reason: requestData.reason || 'From chat', location: { latitude: location.latitude, longitude: location.longitude }, distanceFromCollege: locCheck.distance, locationVerified: true, isPastDate: reqDate < todayStr, status: 'Pending' });
            const replyText = `✅ **Request submitted!**\n\n• **Date:** ${reqDate}\n• **Type:** ${lectureType.replace('_', ' ')}\n${subject ? `• **Subject:** ${subject}\n` : ''}• **Location:** ${locCheck.distance}m (verified)\n• **Status:** Pending admin review`;
            if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: replyText }); existingChat.updatedAt = new Date(); await existingChat.save(); }
            return res.json({ reply: replyText, threadId: existingChat?.threadId, title: existingChat?.title || 'Request', aiOk: true, usedDatabase: true, dbResult: newReq, requestSubmitted: true });
          } else {
            return res.json({ reply: `📍 **Location verification required**\n\nShare your location so I can verify you are on campus (within ${COLLEGE_RADIUS}m).`, threadId, title: 'Request', aiOk: true, usedDatabase: true, needsLocation: true, requestData: intent.data || {}, explanation: intent.explanation });
          }
        }

        if (intent.action === 'db_review_request') {
          const execResult = await executeDbAction(intent, { role: userRole, rollNo: cr, name: userName, branch: userBranch });
          let replyText;
          if (execResult.error) replyText = `❌ ${execResult.error}`;
          else { const r = execResult.result; replyText = `✅ **Request ${r.status}**\nID: ${r.requestId}\nMarked: ${r.marked || 0}/${r.totalRequested || 0} lectures${r.markedSubjects?.length ? '\nSubjects: ' + r.markedSubjects.join(', ') : ''}`; }
          if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: replyText }); existingChat.updatedAt = new Date(); await existingChat.save(); }
          return res.json({ reply: replyText, threadId: existingChat?.threadId, aiOk: true, usedDatabase: true, dbResult: execResult.result, dbError: execResult.error });
        }

        if (intent.action !== 'reply') {
          if (intent.requiresConfirmation) return res.json({ reply: `⚠️ ${intent.explanation || 'Confirm?'}`, threadId, aiOk: true, usedContext: useCtx, usedDatabase: true, dbOp: intent, requiresConfirmation: true });
          const execResult = await executeDbAction(intent, { role: userRole, rollNo: cr, name: userName, branch: userBranch });
          let replyText;
          if (execResult.isReply) replyText = execResult.reply;
          else if (execResult.error) replyText = `❌ ${execResult.error}`;
          else replyText = `✅ ${intent.explanation || 'Done'}\n\n${formatDbResult(execResult.result, intent.action)}`;
          if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: replyText }); existingChat.updatedAt = new Date(); await existingChat.save(); }
          else if (cr !== 'guest') { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: (message || 'Chat').substring(0, 50), messages: [{ role: 'user', content: message }, { role: 'assistant', content: replyText }] }); return res.json({ reply: replyText, threadId: nt.threadId, title: nt.title, aiOk: true, usedDatabase: true, dbResult: execResult.result, dbError: execResult.error }); }
          return res.json({ reply: replyText, threadId: existingChat?.threadId, aiOk: true, usedContext: useCtx, usedDatabase: true, dbResult: execResult.result, dbError: execResult.error });
        }

        if (intent.reply) {
          if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: intent.reply }); existingChat.updatedAt = new Date(); await existingChat.save(); }
          return res.json({ reply: intent.reply, threadId: existingChat?.threadId, aiOk: true, usedDatabase: true });
        }
      } catch (err) { console.warn('DB mode error, falling back:', err.message); }
    }

    // ===== NORMAL CHAT MODE =====
    let contextStr = '';
    if (useCtx && userData) {
      const lines = [];
      const now = new Date();
      const todayStr = getISTDateString(now);
      const tomorrowStr = getISTDateString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      lines.push(`Today: ${todayStr}`);
      lines.push(`Tomorrow: ${tomorrowStr}`);
      lines.push(`User: ${userData.name} (${userData.rollNo}, ${userData.role})`);
      lines.push(`Branch: ${userData.branch || 'CSE'}`);
      lines.push(`---STRICT_TIMETABLE_TODAY---`);
      lines.push(getStrictTimetableResponse(todayStr, userData.branch || 'CSE'));
      lines.push(`---STRICT_TIMETABLE_TOMORROW---`);
      lines.push(getStrictTimetableResponse(tomorrowStr, userData.branch || 'CSE'));
      if (userData.role === 'student') {
        const summary = await getStudentSummary(userData.rollNo);
        if (summary) { lines.push(`Attendance: ${summary.attendancePercentage}% (${summary.totalAcademicLectures}/${summary.totalConductedLectures})`); lines.push(`Days Present: ${summary.daysPresent} / ${summary.workingDaysSoFar}`); const advisor = await getBunkAdvisor(userData.rollNo); if (advisor) lines.push(`Bunk Advisor: ${advisor.message}`); }
      }
      contextStr = lines.join('\n');
    }

    const systemPrompt = `You are "BM Bot" for BM Group of Institutions.
Role: ${userRole}. User: ${userName}.
⚠️ STRICT RULES:
- Use ONLY the STRICT_TIMETABLE sections above. Do NOT invent subjects, times, or faculty.
- Kal = TOMORROW. Aaj = TODAY. Class timing starts at 09:20 AM, NOT 09:00.
- Days Present = UNIQUE days. Do NOT use lecture count.
- If context doesn't have the answer, say "Data available nahi hai" — NEVER guess.
- Use Hinglish, be friendly, use bullet points. NEVER use markdown tables.
${contextStr ? `\n---CONTEXT---\n${contextStr}` : ''}`;

    let reply = '', aiOk = false, provider = 'unknown';
    try {
      const aiResult = await callAI({ prompt: message, systemPrompt, history: existingChat?.messages, maxTokens: 1200, temperature: 0.5 });
      reply = aiResult.reply;
      provider = aiResult.provider;
      aiOk = true;
      console.log(`✅ [AI] Reply via ${provider}`);
    } catch (err) { reply = err.message; }

    let newThreadId = threadId, newTitle = 'New Chat';
    if (cr !== 'guest' && aiOk) {
      if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); if (!existingChat.title || existingChat.title === 'New Chat') existingChat.title = message.substring(0, 50); await existingChat.save(); newThreadId = existingChat.threadId; newTitle = existingChat.title; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: message.substring(0, 50) || 'New Chat', messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; newTitle = nt.title; }
    }
    res.json({ reply, threadId: newThreadId, title: newTitle, aiOk, provider, usedContext: useCtx, usedDatabase: useDb });
  } catch (err) { console.error('❌ Chat error:', err); res.status(500).json({ error: 'Internal error: ' + err.message }); }
});

app.post('/api/ai/chat/confirm-db', async (req, res) => {
  try {
    const { rollNo, operation } = req.body;
    if (!rollNo || !operation) return res.status(400).json({ error: 'rollNo and operation required' });
    const userData = await User.findOne({ rollNo: rollNo.trim().toUpperCase() });
    if (!userData) return res.status(404).json({ error: 'User not found' });
    const execResult = await executeDbAction(operation, { role: userData.role, rollNo: userData.rollNo, name: userData.name, branch: userData.branch || 'CSE' });
    const replyText = execResult.error ? `❌ ${execResult.error}` : `✅ ${operation.explanation || 'Done'}\n\n${formatDbResult(execResult.result, operation.action)}`;
    res.json({ reply: replyText, aiOk: true, dbResult: execResult.result, dbError: execResult.error });
  } catch (err) { console.error('❌ Confirm DB error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Chat with FILE
// ============================================================
app.post('/api/ai/chat-with-file', async (req, res) => {
  try {
    const { prompt, fileBase64, mimeType, rollNo, role, name, branch, threadId } = req.body;
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'fileBase64 and mimeType required.' });
    const userPrompt = prompt || 'Explain this document/file. Give me a clear summary with key points.';
    const cr = rollNo?.trim().toUpperCase() || 'guest';
    let userData = null;
    if (cr !== 'guest') userData = await User.findOne({ rollNo: cr });
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';
    const systemPrompt = `You are "BM Bot" for BM Group. Helping ${userName} (${userRole}). Analyze, summarize, extract. Use markdown. NEVER use tables. Respond in user's language.`;

    // File analysis ONLY via Gemini (supports multimodal)
    let reply = '', aiOk = false;
    try {
      reply = await callGemini({ prompt: userPrompt, systemPrompt, fileBase64, mimeType, maxTokens: 3000, temperature: 0.4 });
      aiOk = true;
      console.log(`✅ [AI] File reply via gemini`);
    } catch (err) { reply = err.message; }

    let newThreadId = threadId, newTitle = 'File Analysis';
    if (cr !== 'guest' && aiOk) {
      const existingChat = threadId ? await Chat.findOne({ threadId, rollNo: cr }) : null;
      if (existingChat) { existingChat.messages.push({ role: 'user', content: `[Uploaded file] ${userPrompt}` }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); await existingChat.save(); newThreadId = existingChat.threadId; newTitle = existingChat.title; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: `File: ${userPrompt.substring(0, 40)}`, messages: [{ role: 'user', content: `[Uploaded file] ${userPrompt}` }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; newTitle = nt.title; }
    }
    res.json({ reply, threadId: newThreadId, title: newTitle, aiOk });
  } catch (err) { console.error('❌ chat-with-file error:', err); res.status(500).json({ error: 'Internal error: ' + err.message }); }
});

// ============================================================
//  AI: Generate PDF Report
// ============================================================
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
        { heading: '📊 Overview', bullets: [`Overall: ${summary.attendancePercentage}%`, `Attended: ${summary.totalAcademicLectures}/${summary.totalConductedLectures}`, `Unique Days Present: ${summary.daysPresent}`, `Status: ${summary.attendancePercentage >= 75 ? '✅ Safe' : '⚠️ Below 75%'}`] },
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
      const students = await User.find({ role: 'student' }).select('rollNo name branch');
      const today = getISTDateString(new Date());
      const startStr = getISTDateString(SEMESTER_START);
      const defaulters = [];
      for (const s of students) {
        const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
        const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
        const pct = total > 0 ? Math.round((present/total)*100) : 0;
        if (total === 0 || pct < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
      }
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

// ============================================================
//  ADMIN REQUESTS — summary
// ============================================================
app.get('/api/admin/requests-summary/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const status = req.query.status || 'Pending';
    const filter = status ? { status } : {};
    const requests = await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    const counts = {
      Pending: await AttendanceRequest.countDocuments({ status: 'Pending' }),
      Approved: await AttendanceRequest.countDocuments({ status: 'Approved' }),
      Rejected: await AttendanceRequest.countDocuments({ status: 'Rejected' }),
      PartiallyApproved: await AttendanceRequest.countDocuments({ status: 'Partially Approved' })
    };
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

// ---------- Global Handlers ----------
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); process.exit(1); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT} | AI: Groq(${GROQ_API_KEYS.length} keys) → Gemini(${GEMINI_API_KEYS.length} keys, ${GEMINI_MODEL})`));
