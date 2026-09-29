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
//  AI PROVIDER CONFIG
// ============================================================
const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3
].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_FALLBACK_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 45000;

const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6
].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const GEMINI_GLOBAL_TIMEOUT_MS = 60000;

const SERVER_START_TIME = Date.now();
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
const COLLEGE_CLOSE_HOUR = 15;
const SEMESTER_START = new Date('2026-07-15T00:00:00+05:30');
const SEMESTER_END = new Date('2026-12-31T23:59:59+05:30');

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }
console.log(`🔑 Groq: ${GROQ_API_KEYS.length} | Gemini: ${GEMINI_API_KEYS.length}`);

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
//  TIMETABLE DATA (Default fallback — DB override possible)
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

// Dynamic timetable cache (admin can override)
let DYNAMIC_TIMETABLE = {}; // { "CSE_5": { Monday: [...], ... }, "AIDS_5": {...} }
let DYNAMIC_SCHEDULE = {};  // { "CSE_5": { 1: [...], ... } }

function getTimetableForBranch(branch, section = '5') {
  const key = `${(branch || 'CSE').toUpperCase()}_${section}`;
  if (DYNAMIC_TIMETABLE[key]) return DYNAMIC_TIMETABLE[key];
  if (branch && branch.toUpperCase() === 'AIDS') return AIDS_TIME_TABLE;
  return CSE_TIME_TABLE;
}
function getScheduleForBranch(branch, section = '5') {
  const key = `${(branch || 'CSE').toUpperCase()}_${section}`;
  if (DYNAMIC_SCHEDULE[key]) return DYNAMIC_SCHEDULE[key];
  return (branch && branch.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE;
}
function getCurrentPeriod(branch = 'CSE', section = '5') {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return null;
  const schedule = getScheduleForBranch(branch, section);
  const daySchedule = schedule[day] || [];
  const mins = getISTMinutes(now);
  for (let slot of daySchedule) {
    const s = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);
    const e = parseInt(slot.end.split(':')[0]) * 60 + parseInt(slot.end.split(':')[1]);
    if (mins >= s && mins < e) return slot;
  }
  return null;
}
function getScheduleForDate(dateStr, branch = 'CSE', section = '5') {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return { isBlocked: true, dayName, schedule: [] };
  const dowIndex = d.getDay();
  const schedule = getScheduleForBranch(branch, section);
  return { isBlocked: false, dayName, schedule: schedule[dowIndex] || [] };
}
function getTimetableForDate(dateStr, branch = 'CSE', section = '5') {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return [];
  return getTimetableForBranch(branch, section)[dayName] || [];
}

function getStrictTimetableResponse(dateStr, branch, section = '5') {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') {
    return `📅 **${dayName} (${dateStr}) — College Closed**\nWeekend, no classes.`;
  }
  const schedule = getScheduleForDate(dateStr, branch, section);
  const slots = schedule.schedule.filter(s => s.period !== 'LUNCH');
  if (!slots.length) return `📅 ${dayName} (${dateStr}) — No classes scheduled.`;
  let txt = `📅 **${dayName} (${dateStr}) — ${branch}-${section} Timetable**\n\n`;
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

// ============================================================
//  AUDIT LOG HELPER
// ============================================================
async function logAudit({ performedBy, performedByRole, actionType, targetId, details }) {
  try {
    await AuditLog.create({
      performedBy: performedBy || 'system',
      performedByRole: performedByRole || 'system',
      actionType,
      targetId: targetId || null,
      details: details || {},
      timestamp: new Date()
    });
  } catch (e) { console.warn('Audit log error:', e.message); }
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
  semester: { type: String, default: '5' },
  section: { type: String, default: 'A' },
  branch: { type: String, default: 'CSE' },
  isActive: { type: Boolean, default: true },
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
  branch: { type: String, default: 'CSE' },
  overriddenBy: { type: String, default: null },
  overrideReason: { type: String, default: null }
}, { timestamps: true });
attendanceSchema.index({ rollNo: 1, subject: 1, date: 1 }, { unique: true });

const holidaySchema = new mongoose.Schema({ date: { type: String, required: true, unique: true }, reason: { type: String, default: 'Holiday' }, declaredBy: String, affectBranches: [String] }, { timestamps: true });
const noticeSchema = new mongoose.Schema({ title: String, message: String, category: { type: String, default: 'general' }, targetGroup: { type: String, default: 'all' }, authorRollNo: String, date: { type: Date, default: Date.now } });

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

const teacherSubjectSchema = new mongoose.Schema({
  teacherRollNo: { type: String, required: true },
  subject: { type: String, required: true },
  branch: { type: String, default: 'CSE' },
  section: { type: String, default: 'A' },
  assignedBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

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
  documentUrl: { type: String, default: null },
  status: { type: String, enum: ['Pending','Approved','Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null }, adminNote: { type: String, default: '' },
  branch: { type: String, default: 'CSE' }
}, { timestamps: true });

const attendanceRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  branch: { type: String, default: 'CSE' },
  date: { type: String, required: true },
  lectureType: { type: String, enum: ['full_day', 'single_lecture'], required: true },
  subject: { type: String, default: null },
  subjects: [{ type: String }],
  period: { type: String, default: null },
  reason: { type: String, default: 'Manual attendance request' },
  location: { latitude: Number, longitude: Number },
  distanceFromCollege: { type: Number, default: null },
  locationVerified: { type: Boolean, default: false },
  isPastDate: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Partially Approved'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  adminNote: { type: String, default: '' },
  facultyNote: { type: String, default: '' },
  reviewHistory: [{
    action: { type: String, enum: ['Approved', 'Rejected'] },
    by: String,
    at: { type: Date, default: Date.now },
    note: { type: String, default: '' },
    reviewedSubjects: [String]
  }]
}, { timestamps: true });

const accountRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  type: { type: String, enum: ['forgot_password', 'device_reset'], required: true },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Used'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  adminNote: { type: String, default: '' }
}, { timestamps: true });

const registrationRequestSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true },
  password: { type: String, required: true },
  deviceId: { type: String, default: null },
  role: { type: String, enum: ['student', 'faculty'], default: 'student' },
  branch: { type: String, default: 'CSE' },
  section: { type: String, default: 'A' },
  subject: { type: String, default: null },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  adminNote: { type: String, default: '' },
  approvedUserRollNo: { type: String, default: null }
}, { timestamps: true });
registrationRequestSchema.index({ rollNo: 1, status: 1 });

// ✅ NEW: Audit Log Schema
const auditLogSchema = new mongoose.Schema({
  performedBy: { type: String, required: true },
  performedByRole: { type: String, default: 'admin' },
  actionType: { type: String, required: true },
  targetId: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now }
}, { timestamps: true });
auditLogSchema.index({ performedBy: 1, timestamp: -1 });
auditLogSchema.index({ actionType: 1, timestamp: -1 });

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
const AuditLog = mongoose.model('AuditLog', auditLogSchema);
Attendance.createIndexes().catch(err => console.error('Index error:', err));

// ============================================================
//  STUDENT SUMMARY
// ============================================================
async function getStudentSummary(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return null;
    const branch = user.branch || 'CSE';
    const section = user.section || '5';
    const timetable = getTimetableForBranch(branch, section);
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

async function getBunkAdvisor(rollNo, targetPercentage = 75) {
  const summary = await getStudentSummary(rollNo);
  if (!summary) return null;
  const { totalAcademicLectures: attended, totalConductedLectures: total, attendancePercentage: pct, workingDaysSoFar, daysPresent } = summary;
  const target = targetPercentage / 100;
  const canBunkLectures = total > 0 ? Math.max(0, Math.floor((attended - target * total) / (1 - target))) : 0;
  const lecturesNeeded = pct >= targetPercentage ? 0 : Math.max(0, Math.ceil((target * total - attended) / (1 - target)));
  const daysNeeded = workingDaysSoFar > 0 ? Math.max(0, Math.ceil(target * workingDaysSoFar - daysPresent)) : 0;
  return {
    totalAttended: attended, totalConducted: total, percentage: pct, targetPercentage,
    daysPresent, workingDaysSoFar, canBunkLectures, lecturesNeeded, daysNeeded,
    status: pct >= targetPercentage ? 'SAFE' : 'DANGER',
    message: pct >= targetPercentage
      ? `✅ You are at ${pct}%. You can safely bunk ~${canBunkLectures} lecture(s) and still stay at ≥${targetPercentage}%.`
      : `⚠️ You are at ${pct}% — BELOW ${targetPercentage}%. You need to attend ${lecturesNeeded} more lecture(s).`
  };
}

// ============================================================
//  AI: GROQ (PRIMARY)
// ============================================================
async function callGroqOnce({ prompt, systemPrompt = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 45000, model = null, apiKey = null }) {
  const useKey = apiKey || getNextGroqKey();
  if (!useKey) throw new Error('No Groq API key');
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${useKey}` },
      body: JSON.stringify({ model: useModel, messages, max_tokens: maxTokens, temperature, top_p: 0.95 }),
      signal: controller.signal
    });
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
  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    let skip = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const apiKey = getNextGroqKey();
      if (!apiKey) break;
      try { return await callGroqOnce({ ...args, model, apiKey }); }
      catch (err) {
        lastError = err;
        if (err.message.includes('404') || err.message.includes('invalid_request')) { skip = true; break; }
        if (err.message.includes('429')) { await new Promise(r => setTimeout(r, 500)); continue; }
        skip = true; break;
      }
    }
    if (skip) continue;
  }
  throw lastError || new Error('Groq failed');
}

// ============================================================
//  AI: GEMINI (FALLBACK)
// ============================================================
async function callGeminiOnce({ prompt, systemPrompt = null, fileBase64 = null, mimeType = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 60000, model = null, apiKey = null }) {
  const useKey = apiKey || getNextGeminiKey();
  if (!useKey) throw new Error('No Gemini API key');
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
  const modelsToTry = [args.model || GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  if (GEMINI_API_KEYS.length === 0) throw new Error('No Gemini API key');
  const startTime = Date.now();
  let lastError = null;
  for (const model of modelsToTry) {
    for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
      if (Date.now() - startTime > GEMINI_GLOBAL_TIMEOUT_MS) throw new Error('AI timeout');
      const apiKey = getNextGeminiKey();
      if (!apiKey) break;
      try { return await callGeminiOnce({ ...args, model, apiKey }); }
      catch (err) {
        lastError = err;
        if (err.message.includes('404') || err.message.includes('400')) break;
      }
    }
  }
  throw lastError || new Error('Gemini failed');
}

async function callAI(args) {
  const GROQ_TIMEOUT = 45000;
  const TOTAL_TIMEOUT = 90000;
  const startTime = Date.now();
  let groqError = null;
  if (GROQ_API_KEYS.length > 0) {
    try {
      const reply = await callGroq({ ...args, timeoutMs: Math.min(GROQ_TIMEOUT, TOTAL_TIMEOUT - (Date.now() - startTime)) });
      return { reply, provider: 'groq', model: GROQ_MODEL };
    } catch (err) { groqError = err; }
  }
  const remainingTime = TOTAL_TIMEOUT - (Date.now() - startTime);
  if (remainingTime <= 0) throw new Error('AI took too long');
  try {
    const reply = await callGemini({ ...args, globalTimeoutMs: remainingTime });
    return { reply, provider: 'gemini', model: GEMINI_MODEL };
  } catch (geminiError) {
    throw new Error(`Both AI failed.`);
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
//  ★★★ ALL 29 TOOLS DEFINITIONS ★★★
// ============================================================
const BOT_TOOLS = [
  // ==================== STUDENT (7) ====================
  {
    name: "get_student_summary",
    description: "Fetch complete attendance summary and subject-wise stats for a student.",
    parameters: { type: "OBJECT", properties: { rollNo: { type: "STRING" } }, required: ["rollNo"] }
  },
  {
    name: "get_bunk_advisor",
    description: "Calculate safe bunk lectures. Default target 75%.",
    parameters: { type: "OBJECT", properties: { rollNo: { type: "STRING" }, targetPercentage: { type: "NUMBER", description: "Default 75" } }, required: ["rollNo"] }
  },
  {
    name: "get_timetable",
    description: "Get class timetable. Use 'date' for specific date, 'day' for weekday, or 'week' for full week.",
    parameters: { type: "OBJECT", properties: { date: { type: "STRING", description: "YYYY-MM-DD" }, day: { type: "STRING", description: "Monday/Tuesday/etc" }, week: { type: "BOOLEAN" } }, required: [] }
  },
  {
    name: "submit_attendance_request",
    description: "Submit attendance request for past date or today after 3 PM.",
    parameters: { type: "OBJECT", properties: { date: { type: "STRING" }, lectureType: { type: "STRING", enum: ["full_day", "single_lecture"] }, subject: { type: "STRING" }, reason: { type: "STRING" } }, required: ["date", "lectureType"] }
  },
  {
    name: "apply_leave_request",
    description: "Apply for leave with optional document URL.",
    parameters: { type: "OBJECT", properties: { fromDate: { type: "STRING" }, toDate: { type: "STRING" }, reason: { type: "STRING" }, leaveType: { type: "STRING", enum: ["Sick","Personal","Event","Other"] }, documentUrl: { type: "STRING" } }, required: ["fromDate", "toDate", "reason"] }
  },
  {
    name: "get_notices",
    description: "Fetch latest notices with optional category filter.",
    parameters: { type: "OBJECT", properties: { category: { type: "STRING" }, limit: { type: "NUMBER", description: "Default 5" } }, required: [] }
  },
  {
    name: "download_student_pdf",
    description: "Generate PDF report of student attendance. Returns base64 PDF.",
    parameters: { type: "OBJECT", properties: { rollNo: { type: "STRING" } }, required: ["rollNo"] }
  },

  // ==================== FACULTY (7) ====================
  {
    name: "get_assigned_subjects",
    description: "Get list of subjects assigned to faculty.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "get_class_attendance_summary",
    description: "Get class attendance summary by subject, branch, section.",
    parameters: { type: "OBJECT", properties: { subjectCode: { type: "STRING" }, branch: { type: "STRING" }, section: { type: "STRING" } }, required: [] }
  },
  {
    name: "get_defaulter_list",
    description: "Get students below attendance threshold (default 75%).",
    parameters: { type: "OBJECT", properties: { branch: { type: "STRING" }, section: { type: "STRING" }, threshold: { type: "NUMBER" } }, required: [] }
  },
  {
    name: "review_student_request",
    description: "Approve or reject a student attendance request.",
    parameters: { type: "OBJECT", properties: { requestId: { type: "STRING" }, action: { type: "STRING", enum: ["Approved", "Rejected"] }, facultyNote: { type: "STRING" } }, required: ["requestId", "action"] }
  },
  {
    name: "bulk_mark_attendance",
    description: "Bulk mark attendance for multiple students on multiple dates.",
    parameters: { type: "OBJECT", properties: { date: { type: "STRING" }, subjectCode: { type: "STRING" }, branch: { type: "STRING" }, section: { type: "STRING" }, studentRollsStatus: { type: "ARRAY", items: { type: "OBJECT" } } }, required: [] }
  },
  {
    name: "get_faculty_timetable",
    description: "Get faculty's own teaching schedule for a date or week.",
    parameters: { type: "OBJECT", properties: { date: { type: "STRING" }, week: { type: "BOOLEAN" } }, required: [] }
  },
  {
    name: "download_class_report_pdf",
    description: "Generate class attendance PDF for a subject/branch/section.",
    parameters: { type: "OBJECT", properties: { subjectCode: { type: "STRING" }, branch: { type: "STRING" }, section: { type: "STRING" } }, required: [] }
  },

  // ==================== ADMIN (15) ====================
  // Account Management
  {
    name: "get_pending_account_requests",
    description: "Get pending password/device reset requests. Admin only.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "review_account_request",
    description: "Approve/reject a password/device reset request. Admin only.",
    parameters: { type: "OBJECT", properties: { requestId: { type: "STRING" }, action: { type: "STRING", enum: ["Approved", "Rejected"] }, adminNote: { type: "STRING" } }, required: ["requestId", "action"] }
  },
  {
    name: "reset_user_device",
    description: "Unbind user's device binding. Admin only.",
    parameters: { type: "OBJECT", properties: { targetRollNo: { type: "STRING" } }, required: ["targetRollNo"] }
  },
  {
    name: "manage_user_profile",
    description: "Update user profile (name, branch, section, role, status). Admin only.",
    parameters: { type: "OBJECT", properties: { targetRollNo: { type: "STRING" }, updateData: { type: "OBJECT" } }, required: ["targetRollNo", "updateData"] }
  },
  // Attendance Control
  {
    name: "toggle_passcode_system",
    description: "Enable/disable passcode system. Admin only.",
    parameters: { type: "OBJECT", properties: { status: { type: "BOOLEAN" }, branch: { type: "STRING" }, duration: { type: "NUMBER" } }, required: ["status"] }
  },
  {
    name: "force_update_attendance",
    description: "Force set a single student's attendance on a date/subject. Admin only.",
    parameters: { type: "OBJECT", properties: { rollNo: { type: "STRING" }, date: { type: "STRING" }, subjectCode: { type: "STRING" }, status: { type: "STRING", enum: ["Present", "Absent", "Duty Leave"] } }, required: ["rollNo", "date", "subjectCode", "status"] }
  },
  {
    name: "bulk_override_attendance",
    description: "Override entire class attendance for a date/subject. Admin only.",
    parameters: { type: "OBJECT", properties: { branch: { type: "STRING" }, section: { type: "STRING" }, date: { type: "STRING" }, subjectCode: { type: "STRING" }, status: { type: "STRING", enum: ["Present", "Absent", "Duty Leave"] } }, required: ["branch", "date", "subjectCode", "status"] }
  },
  {
    name: "mark_college_holiday",
    description: "Mark a date as college holiday. Admin only.",
    parameters: { type: "OBJECT", properties: { date: { type: "STRING" }, reason: { type: "STRING" }, affectBranches: { type: "ARRAY", items: { type: "STRING" } } }, required: ["date", "reason"] }
  },
  // Academic Setup
  {
    name: "assign_faculty_subject",
    description: "Assign subject to faculty with branch/section. Admin only.",
    parameters: { type: "OBJECT", properties: { facultyId: { type: "STRING" }, subjectCode: { type: "STRING" }, branch: { type: "STRING" }, section: { type: "STRING" } }, required: ["facultyId", "subjectCode"] }
  },
  {
    name: "update_timetable_schedule",
    description: "Update class timetable for a specific day. Admin only.",
    parameters: { type: "OBJECT", properties: { branch: { type: "STRING" }, section: { type: "STRING" }, day: { type: "STRING" }, scheduleArray: { type: "ARRAY", items: { type: "OBJECT" } } }, required: ["branch", "day", "scheduleArray"] }
  },
  // Analytics & Reports
  {
    name: "get_college_analytics",
    description: "Get college-wide analytics. Admin only.",
    parameters: { type: "OBJECT", properties: { startDate: { type: "STRING" }, endDate: { type: "STRING" }, branch: { type: "STRING" } }, required: [] }
  },
  {
    name: "get_global_defaulter_list",
    description: "Global defaulter list with optional branch/threshold. Admin only.",
    parameters: { type: "OBJECT", properties: { branch: { type: "STRING" }, threshold: { type: "NUMBER" }, format: { type: "STRING", enum: ["list", "pdf"] } }, required: [] }
  },
  {
    name: "generate_report_pdf",
    description: "Generate custom PDF report. Admin/faculty only.",
    parameters: { type: "OBJECT", properties: { reportType: { type: "STRING", enum: ["student_attendance", "defaulter_list", "class_attendance", "college_summary"] }, filters: { type: "OBJECT" } }, required: ["reportType"] }
  },
  {
    name: "get_audit_logs",
    description: "Fetch system audit logs. Admin only.",
    parameters: { type: "OBJECT", properties: { performedBy: { type: "STRING" }, actionType: { type: "STRING" }, limit: { type: "NUMBER" } }, required: [] }
  },
  // Broadcast
  {
    name: "send_broadcast_notice",
    description: "Send college-wide or targeted notice. Admin only.",
    parameters: { type: "OBJECT", properties: { targetGroup: { type: "STRING", enum: ["all", "students", "faculty", "CSE", "AIDS"] }, title: { type: "STRING" }, message: { type: "STRING" } }, required: ["targetGroup", "message"] }
  },
  // Legacy tools kept for backward compat
  {
    name: "get_pending_registration_requests",
    description: "Get pending registration requests. Admin only.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "review_registration_request",
    description: "Approve/reject registration. Admin only.",
    parameters: { type: "OBJECT", properties: { requestId: { type: "STRING" }, action: { type: "STRING", enum: ["Approved", "Rejected"] }, note: { type: "STRING" } }, required: ["requestId", "action"] }
  },
  {
    name: "get_pending_requests_summary",
    description: "Get count of all pending requests. Admin only.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  }
];

// ============================================================
//  ★★★ TOOL EXECUTOR (Role-Based, All 29 Tools) ★★★
// ============================================================
async function executeBotTool(toolName, args, userContext) {
  const { rollNo, role, branch, name } = userContext;
  const isAdmin = role === 'admin';
  const isFaculty = role === 'faculty';
  const isStudent = role === 'student';

  console.log(`🔧 [TOOL] ${toolName} | ${role} | ${JSON.stringify(args).substring(0, 150)}`);

  try {
    switch (toolName) {

      // ==================== STUDENT TOOLS ====================
      case "get_student_summary": {
        let targetRoll = args.rollNo ? args.rollNo.toUpperCase().trim() : rollNo;
        if (isStudent && targetRoll !== rollNo) return { error: `⛔ Access Denied. Only your own summary.` };
        const summary = await getStudentSummary(targetRoll);
        if (!summary) return { error: `Student ${targetRoll} not found.` };
        return {
          rollNo: targetRoll,
          attendancePercentage: summary.attendancePercentage,
          attended: summary.totalAcademicLectures,
          conducted: summary.totalConductedLectures,
          daysPresent: summary.daysPresent,
          workingDaysSoFar: summary.workingDaysSoFar,
          totalWorkingDaysSemester: summary.totalWorkingDaysSemester,
          subjectStats: summary.subjectStats,
          status: summary.attendancePercentage >= 75 ? 'Safe ✅' : 'Below 75% ⚠️'
        };
      }

      case "get_bunk_advisor": {
        let targetRoll = args.rollNo ? args.rollNo.toUpperCase().trim() : rollNo;
        if (isStudent && targetRoll !== rollNo) return { error: `⛔ Access Denied.` };
        const advisor = await getBunkAdvisor(targetRoll, args.targetPercentage || 75);
        if (!advisor) return { error: 'Student not found.' };
        return advisor;
      }

      case "get_timetable": {
        const br = branch || 'CSE';
        const sec = userContext.section || '5';
        if (args.week) {
          const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
          const result = {};
          days.forEach(d => {
            const tt = getTimetableForBranch(br, sec);
            result[d] = (tt[d] || []).map(x => `${x.subject} (${x.faculty})`);
          });
          return { branch: br, section: sec, week: result };
        }
        if (args.day) {
          const tt = getTimetableForBranch(br, sec);
          const daySubs = tt[args.day] || [];
          return { branch: br, section: sec, day: args.day, subjects: daySubs.map(x => `${x.subject} (${x.faculty})`) };
        }
        const date = args.date || getISTDateString(new Date());
        return { date, branch: br, section: sec, formatted: getStrictTimetableResponse(date, br, sec) };
      }

      case "submit_attendance_request": {
        if (!isStudent) return { error: 'Only students can submit attendance requests.' };
        const todayStr = getISTDateString(new Date());
        const reqDate = args.date;
        const lectureType = args.lectureType || 'full_day';
        if (!reqDate) return { error: 'Date required.' };
        if (reqDate > todayStr) return { error: `🚫 Future date not allowed.` };
        if (reqDate === todayStr && getISTHour(new Date()) < COLLEGE_CLOSE_HOUR) return { error: '⏰ Today\'s request only after 3 PM.' };
        const ds = await checkDateStatus(reqDate);
        if (ds.isBlocked) return { error: ds.type === 'WEEKEND' ? `${ds.dayName}: Closed.` : `Holiday: ${ds.holiday || 'Closed'}.` };
        if (lectureType === 'single_lecture' && !args.subject) return { error: 'Subject required for single lecture.' };
        const dup = await AttendanceRequest.findOne({ rollNo, date: reqDate, lectureType, status: 'Pending' });
        if (dup) return { error: `Already have a pending request for ${reqDate}.` };
        const newReq = await AttendanceRequest.create({
          rollNo, studentName: name, branch: branch || 'CSE',
          date: reqDate, lectureType,
          subject: args.subject ? mapToCanonical(args.subject) : null,
          reason: args.reason || 'Requested via BM Bot',
          status: 'Pending',
          isPastDate: reqDate < todayStr
        });
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'submit_attendance_request', targetId: newReq._id.toString(), details: { date: reqDate, lectureType } });
        return { success: true, requestId: newReq._id, message: `✅ Request submitted for ${reqDate}.` };
      }

      case "apply_leave_request": {
        if (!isStudent) return { error: 'Only students can apply leave.' };
        if (!args.fromDate || !args.toDate || !args.reason) return { error: 'fromDate, toDate, reason required.' };
        if (new Date(args.toDate) < new Date(args.fromDate)) return { error: 'toDate must be after fromDate.' };
        const leave = await Leave.create({
          rollNo, studentName: name,
          fromDate: args.fromDate, toDate: args.toDate,
          reason: args.reason, leaveType: args.leaveType || 'Personal',
          documentUrl: args.documentUrl || null,
          branch: branch || 'CSE'
        });
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'apply_leave', targetId: leave._id.toString(), details: { from: args.fromDate, to: args.toDate } });
        return { success: true, leaveId: leave._id, message: `✅ Leave applied: ${args.fromDate} to ${args.toDate}.` };
      }

      case "get_notices": {
        const limit = Math.min(args.limit || 5, 20);
        const filter = {};
        if (args.category) filter.category = args.category;
        const notices = await Notice.find(filter).sort({ date: -1 }).limit(limit).lean();
        return { count: notices.length, notices: notices.map(n => ({ title: n.title, message: n.message, date: n.date, category: n.category })) };
      }

      case "download_student_pdf": {
        const target = args.rollNo ? args.rollNo.toUpperCase() : rollNo;
        if (isStudent && target !== rollNo) return { error: 'Students can only download own report.' };
        const targetUser = await User.findOne({ rollNo: target });
        if (!targetUser) return { error: 'Student not found.' };
        const summary = await getStudentSummary(target);
        if (!summary) return { error: 'Cannot compute.' };
        const rows = Object.entries(summary.subjectStats).map(([sub, st]) => [sub, `${st.present}/${st.total}`, `${st.percentage}%`]);
        const pdfBuffer = await generatePDFBuffer({
          title: `Attendance Report - ${targetUser.name}`,
          subtitle: `${targetUser.rollNo} • ${targetUser.branch || 'CSE'} • Overall: ${summary.attendancePercentage}%`,
          sections: [
            { heading: 'Summary', bullets: [`Overall: ${summary.attendancePercentage}%`, `Attended: ${summary.totalAcademicLectures}/${summary.totalConductedLectures}`, `Days Present: ${summary.daysPresent}/${summary.workingDaysSoFar}`] },
            { heading: 'Subject-wise', table: { headers: ['Subject', 'P/T', '%'], rows } }
          ]
        });
        return { success: true, filename: `attendance_${target}.pdf`, pdfBase64: pdfBuffer.toString('base64'), message: `PDF ready for ${targetUser.name}.` };
      }

      // ==================== FACULTY TOOLS ====================
      case "get_assigned_subjects": {
        if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
        const assignments = await TeacherSubject.find({ teacherRollNo: rollNo }).lean();
        return { count: assignments.length, subjects: assignments.map(a => ({ subject: a.subject, branch: a.branch, section: a.section })) };
      }

      case "get_class_attendance_summary": {
        if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
        let subjects = await TeacherSubject.find({ teacherRollNo: rollNo }).distinct('subject');
        if (args.subjectCode) {
          const canon = mapToCanonical(args.subjectCode);
          subjects = subjects.filter(s => s === canon);
          if (!subjects.length) return { error: `You don't teach ${args.subjectCode}.` };
        }
        if (!subjects.length) return { error: 'No subjects assigned.' };
        const filter = { subject: { $in: subjects } };
        if (args.branch) filter.branch = args.branch.toUpperCase();
        const allRecs = await Attendance.find(filter);
        const present = allRecs.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
        const total = allRecs.length;
        const avg = total > 0 ? Math.round((present / total) * 100) : 0;
        const subjectWise = {};
        subjects.forEach(s => { subjectWise[s] = { present: 0, total: 0 }; });
        allRecs.forEach(r => {
          const s = mapToCanonical(r.subject);
          if (subjectWise[s]) {
            subjectWise[s].total++;
            if (r.status === 'Present' || r.status === 'Duty Leave') subjectWise[s].present++;
          }
        });
        Object.keys(subjectWise).forEach(s => {
          subjectWise[s].percentage = subjectWise[s].total > 0 ? Math.round((subjectWise[s].present / subjectWise[s].total) * 100) : 0;
        });
        const studentRolls = await Attendance.find(filter).distinct('rollNo');
        return { subjects, totalStudents: studentRolls.length, overallAverage: avg, subjectWise };
      }

      case "get_defaulter_list": {
        if (isStudent) return { error: '⛔ Only faculty/admin.' };
        const threshold = args.threshold || 75;
        let q = { role: 'student' };
        if (args.branch) q.branch = args.branch.toUpperCase();
        else if (isFaculty) q.branch = branch || 'CSE';
        if (args.section) q.section = args.section;
        const students = await User.find(q).select('name rollNo branch section');
        const defaulters = [];
        for (const s of students) {
          const summary = await getStudentSummary(s.rollNo);
          if (summary && summary.attendancePercentage < threshold) {
            defaulters.push({ name: s.name, rollNo: s.rollNo, branch: s.branch, section: s.section, percentage: summary.attendancePercentage, attended: summary.totalAcademicLectures, total: summary.totalConductedLectures });
          }
        }
        defaulters.sort((a, b) => a.percentage - b.percentage);
        return { count: defaulters.length, threshold, defaulters: defaulters.slice(0, 100) };
      }

      case "review_student_request": {
        if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
        if (!args.requestId || !args.action) return { error: 'requestId and action required.' };
        if (!['Approved', 'Rejected'].includes(args.action)) return { error: 'Invalid action.' };
        const request = await AttendanceRequest.findById(args.requestId);
        if (!request) return { error: 'Request not found.' };
        if (request.status !== 'Pending') return { error: `Already ${request.status}.` };
        const note = args.facultyNote || args.note || '';
        if (args.action === 'Rejected') {
          request.status = 'Rejected'; request.reviewedBy = rollNo; request.facultyNote = note;
          request.reviewHistory.push({ action: 'Rejected', by: rollNo, at: new Date(), note });
          await request.save();
          await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'reject_attendance_request', targetId: request._id.toString(), details: { student: request.rollNo } });
          return { success: true, message: `Request rejected.` };
        }
        const b = request.branch || 'CSE';
        const schedule = getScheduleForDate(request.date, b);
        let subjectsToMark = [];
        if (request.lectureType === 'full_day') {
          subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
        } else if (request.subject) subjectsToMark = [mapToCanonical(request.subject)];
        let marked = 0;
        for (const sub of subjectsToMark) {
          try {
            const ex = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date });
            if (!ex) { await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: null, ipAddress: 'bot-review', isVerified: false, branch: b }); marked++; }
          } catch (e) {}
        }
        request.status = 'Approved'; request.reviewedBy = rollNo; request.facultyNote = note;
        request.reviewHistory.push({ action: 'Approved', by: rollNo, at: new Date(), note, reviewedSubjects: subjectsToMark });
        await request.save();
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'approve_attendance_request', targetId: request._id.toString(), details: { student: request.rollNo, marked } });
        return { success: true, message: `Approved. ${marked} lecture(s) marked.` };
      }

      case "bulk_mark_attendance": {
        if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
        let studentRolls = [];
        let statusMap = {};
        if (args.studentRollsStatus && Array.isArray(args.studentRollsStatus)) {
          args.studentRollsStatus.forEach(item => {
            if (item.rollNo) { studentRolls.push(item.rollNo); statusMap[item.rollNo] = item.status || 'Present'; }
          });
        }
        if (args.studentRollNos) studentRolls = args.studentRollNos;
        if (!studentRolls.length) return { error: 'No students.' };
        const dates = args.dates || (args.date ? [args.date] : []);
        if (!dates.length) return { error: 'No dates.' };
        let subjects = [];
        if (args.subjectCode) subjects = [mapToCanonical(args.subjectCode)];
        else if (isFaculty) subjects = await TeacherSubject.find({ teacherRollNo: rollNo }).distinct('subject');
        if (!subjects.length) return { error: 'No subjects.' };
        const students = await User.find({ rollNo: { $in: studentRolls }, role: 'student' });
        let totalMarked = 0, totalSkipped = 0;
        for (const s of students) {
          const b = s.branch || 'CSE';
          for (const date of dates) {
            const ds = await checkDateStatus(date);
            if (ds.isBlocked) continue;
            for (const sub of subjects) {
              try {
                const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date });
                if (!ex) { await Attendance.create({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: statusMap[s.rollNo] || args.status || 'Present', location: null, ipAddress: 'bot-bulk', isVerified: false, branch: b }); totalMarked++; }
                else totalSkipped++;
              } catch (e) { if (e.code === 11000) totalSkipped++; }
            }
          }
        }
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'bulk_mark_attendance', details: { count: totalMarked, students: students.length, dates } });
        return { success: true, totalMarked, totalSkipped, message: `✅ ${totalMarked} new, ${totalSkipped} skipped.` };
      }

      case "get_faculty_timetable": {
        if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
        const assignments = await TeacherSubject.find({ teacherRollNo: rollNo }).lean();
        if (!assignments.length) return { error: 'No subjects assigned.' };
        const subjects = assignments.map(a => a.subject);
        const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
        const schedule = {};
        for (const day of days) {
          const daySchedule = getTimetableForBranch(branch || 'CSE', userContext.section || '5')[day] || [];
          const mySlots = daySchedule.filter(x => subjects.includes(mapToCanonical(x.subject)));
          if (mySlots.length) schedule[day] = mySlots.map(x => `${x.subject} (${x.faculty})`);
        }
        return { teacher: name, subjects, weeklySchedule: schedule };
      }

      case "download_class_report_pdf": {
        if (!isFaculty && !isAdmin) return { error: 'Faculty/Admin only.' };
        const subjectCode = args.subjectCode ? mapToCanonical(args.subjectCode) : null;
        const targetBranch = args.branch ? args.branch.toUpperCase() : (branch || 'CSE');
        let q = { role: 'student', branch: targetBranch };
        if (args.section) q.section = args.section;
        const students = await User.find(q).select('rollNo name branch section');
        const rows = [];
        for (const s of students) {
          const summary = await getStudentSummary(s.rollNo);
          if (!summary) continue;
          let present = 0, total = 0;
          if (subjectCode && summary.subjectStats[subjectCode]) {
            present = summary.subjectStats[subjectCode].present;
            total = summary.subjectStats[subjectCode].total;
          } else {
            present = summary.totalAcademicLectures;
            total = summary.totalConductedLectures;
          }
          const pct = total > 0 ? Math.round((present / total) * 100) : 0;
          rows.push([s.rollNo, s.name, `${present}/${total}`, `${pct}%`]);
        }
        const pdfBuffer = await generatePDFBuffer({
          title: `Class Attendance Report${subjectCode ? ' - ' + subjectCode : ''}`,
          subtitle: `${targetBranch}${args.section ? '-' + args.section : ''} | Students: ${students.length}`,
          sections: [{ heading: 'Attendance', table: { headers: ['Roll', 'Name', 'P/T', '%'], rows } }]
        });
        return { success: true, filename: `class_report_${targetBranch}.pdf`, pdfBase64: pdfBuffer.toString('base64'), message: `Report ready for ${students.length} students.` };
      }

      // ==================== ADMIN TOOLS ====================
      case "get_pending_account_requests": {
        if (!isAdmin) return { error: 'Admin only.' };
        const requests = await AccountRequest.find({ status: 'Pending' }).sort({ createdAt: -1 }).limit(50).lean();
        return { count: requests.length, requests };
      }

      case "review_account_request": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { requestId, action, adminNote } = args;
        if (!requestId || !action) return { error: 'requestId and action required.' };
        if (!['Approved', 'Rejected'].includes(action)) return { error: 'Invalid action.' };
        const reqDoc = await AccountRequest.findById(requestId);
        if (!reqDoc) return { error: 'Not found.' };
        reqDoc.status = action; reqDoc.reviewedBy = rollNo; reqDoc.adminNote = adminNote || 'Via BM Bot';
        await reqDoc.save();
        if (action === 'Approved' && reqDoc.type === 'device_reset') {
          await User.updateOne({ rollNo: reqDoc.rollNo }, { $set: { boundDeviceId: null } });
        }
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'review_account_request', targetId: requestId, details: { action, type: reqDoc.type, targetUser: reqDoc.rollNo } });
        return { success: true, message: `Request ${action}.` };
      }

      case "reset_user_device": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { targetRollNo } = args;
        if (!targetRollNo) return { error: 'targetRollNo required.' };
        const user = await User.findOne({ rollNo: targetRollNo.toUpperCase() });
        if (!user) return { error: 'User not found.' };
        user.boundDeviceId = null;
        await user.save();
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'reset_user_device', targetId: targetRollNo, details: {} });
        return { success: true, message: `✅ Device reset for ${targetRollNo}.` };
      }

      case "manage_user_profile": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { targetRollNo, updateData } = args;
        if (!targetRollNo || !updateData) return { error: 'targetRollNo and updateData required.' };
        const allowed = ['name', 'branch', 'section', 'role', 'semester', 'email', 'phone', 'isActive'];
        const cleanUpdate = {};
        for (const k of Object.keys(updateData)) {
          if (allowed.includes(k)) cleanUpdate[k] = updateData[k];
        }
        if (!Object.keys(cleanUpdate).length) return { error: 'No valid fields to update.' };
        const user = await User.findOneAndUpdate({ rollNo: targetRollNo.toUpperCase() }, { $set: cleanUpdate }, { new: true }).select('-password');
        if (!user) return { error: 'User not found.' };
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'manage_user_profile', targetId: targetRollNo, details: cleanUpdate });
        return { success: true, updatedFields: Object.keys(cleanUpdate), user: { rollNo: user.rollNo, name: user.name, role: user.role, branch: user.branch } };
      }

      case "toggle_passcode_system": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { status, duration } = args;
        if (typeof status !== 'boolean') return { error: 'status must be boolean.' };
        await Passcode.updateMany({}, { $set: { enabled: status } });
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'toggle_passcode_system', details: { status, duration } });
        return { success: true, enabled: status, message: `Passcode system ${status ? 'ENABLED ✅' : 'DISABLED ⛔'}.` };
      }

      case "force_update_attendance": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { rollNo: targetRoll, date, subjectCode, status } = args;
        if (!targetRoll || !date || !subjectCode || !status) return { error: 'All fields required.' };
        if (!['Present', 'Absent', 'Duty Leave'].includes(status)) return { error: 'Invalid status.' };
        const student = await User.findOne({ rollNo: targetRoll.toUpperCase(), role: 'student' });
        if (!student) return { error: 'Student not found.' };
        const canon = mapToCanonical(subjectCode);
        const existing = await Attendance.findOne({ rollNo: targetRoll.toUpperCase(), date, subject: canon });
        if (existing) {
          existing.status = status;
          existing.overriddenBy = rollNo;
          existing.overrideReason = 'Force updated by admin';
          existing.isVerified = true;
          await existing.save();
        } else {
          await Attendance.create({
            rollNo: targetRoll.toUpperCase(), studentName: student.name,
            subject: canon, date, status,
            location: null, ipAddress: 'admin-force',
            isVerified: true, branch: student.branch || 'CSE',
            overriddenBy: rollNo, overrideReason: 'Force created by admin'
          });
        }
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'force_update_attendance', targetId: targetRoll, details: { date, subject: canon, status } });
        return { success: true, message: `✅ ${targetRoll} → ${status} on ${date} (${canon}).` };
      }

      case "bulk_override_attendance": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { branch: targetBranch, section, date, subjectCode, status } = args;
        if (!targetBranch || !date || !subjectCode || !status) return { error: 'branch, date, subjectCode, status required.' };
        if (!['Present', 'Absent', 'Duty Leave'].includes(status)) return { error: 'Invalid status.' };
        const q = { role: 'student', branch: targetBranch.toUpperCase() };
        if (section) q.section = section;
        const students = await User.find(q).select('rollNo name branch');
        if (!students.length) return { error: 'No students found.' };
        const canon = mapToCanonical(subjectCode);
        let updated = 0, created = 0;
        for (const s of students) {
          const ex = await Attendance.findOne({ rollNo: s.rollNo, date, subject: canon });
          if (ex) {
            ex.status = status; ex.overriddenBy = rollNo; ex.isVerified = true;
            await ex.save(); updated++;
          } else {
            await Attendance.create({ rollNo: s.rollNo, studentName: s.name, subject: canon, date, status, location: null, ipAddress: 'admin-bulk-override', isVerified: true, branch: s.branch, overriddenBy: rollNo });
            created++;
          }
        }
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'bulk_override_attendance', details: { branch: targetBranch, section, date, subject: canon, status, updated, created } });
        return { success: true, updated, created, total: students.length, message: `✅ ${updated} updated, ${created} created for ${targetBranch}${section ? '-' + section : ''}.` };
      }

      case "mark_college_holiday": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { date, reason, affectBranches } = args;
        if (!date || !reason) return { error: 'date and reason required.' };
        const parts = date.split('-');
        const dobj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const dn = days[dobj.getDay()];
        if (dn === 'Saturday' || dn === 'Sunday') return { error: 'Already weekend.' };
        await Holiday.findOneAndUpdate({ date }, { date, reason, declaredBy: rollNo, affectBranches: affectBranches || ['ALL'] }, { upsert: true });
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'mark_college_holiday', details: { date, reason, affectBranches } });
        return { success: true, message: `✅ ${date} declared holiday: ${reason}.` };
      }

      case "assign_faculty_subject": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { facultyId, subjectCode, branch: fb, section: fs } = args;
        if (!facultyId || !subjectCode) return { error: 'facultyId and subjectCode required.' };
        const teacher = await User.findOne({ rollNo: facultyId.toUpperCase(), role: 'faculty' });
        if (!teacher) return { error: 'Faculty not found.' };
        const canon = mapToCanonical(subjectCode);
        const existing = await TeacherSubject.findOne({ teacherRollNo: facultyId.toUpperCase(), subject: canon });
        if (existing) return { error: 'Already assigned.' };
        await TeacherSubject.create({
          teacherRollNo: facultyId.toUpperCase(),
          subject: canon,
          branch: fb || teacher.branch || 'CSE',
          section: fs || teacher.section || 'A',
          assignedBy: rollNo
        });
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'assign_faculty_subject', targetId: facultyId, details: { subject: canon, branch: fb, section: fs } });
        return { success: true, message: `✅ ${canon} assigned to ${teacher.name}.` };
      }

      case "update_timetable_schedule": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { branch: tb, section: ts, day, scheduleArray } = args;
        if (!tb || !day || !scheduleArray) return { error: 'branch, day, scheduleArray required.' };
        if (!Array.isArray(scheduleArray)) return { error: 'scheduleArray must be array.' };
        const sec = ts || '5';
        const key = `${tb.toUpperCase()}_${sec}`;
        if (!DYNAMIC_SCHEDULE[key]) DYNAMIC_SCHEDULE[key] = JSON.parse(JSON.stringify((tb.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE));
        const dowNames = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
        const dow = dowNames[day];
        if (dow === undefined) return { error: 'Invalid day.' };
        DYNAMIC_SCHEDULE[key][dow] = scheduleArray;
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'update_timetable_schedule', details: { branch: tb, section: sec, day, periods: scheduleArray.length } });
        return { success: true, message: `✅ Timetable updated for ${tb}-${sec} on ${day}.` };
      }

      case "get_college_analytics": {
        if (!isAdmin) return { error: 'Admin only.' };
        const totalStudents = await User.countDocuments({ role: 'student' });
        const totalFaculty = await User.countDocuments({ role: 'faculty' });
        const todayStr = getISTDateString(new Date());
        const todayPresentRolls = await Attendance.distinct('rollNo', { date: todayStr, status: 'Present' });
        const totalAtt = await Attendance.countDocuments();
        const presentCount = await Attendance.countDocuments({ status: 'Present' });
        const overallPct = totalAtt > 0 ? Math.round((presentCount / totalAtt) * 100) : 0;
        const pendingAttRequests = await AttendanceRequest.countDocuments({ status: 'Pending' });
        const pendingAccRequests = await AccountRequest.countDocuments({ status: 'Pending' });
        const pendingRegRequests = await RegistrationRequest.countDocuments({ status: 'Pending' });
        const pendingLeaves = await Leave.countDocuments({ status: 'Pending' });
        const branchWise = {};
        for (const b of ['CSE', 'AIDS']) {
          const bc = await User.countDocuments({ role: 'student', branch: b });
          const bPresent = await Attendance.distinct('rollNo', { date: todayStr, status: 'Present', branch: b });
          branchWise[b] = { totalStudents: bc, presentToday: bPresent.length };
        }
        return { totalStudents, totalFaculty, todayPresent: todayPresentRolls.length, todayAbsent: totalStudents - todayPresentRolls.length, overallPct, totalAttendanceRecords: totalAtt, pendingAttendanceRequests: pendingAttRequests, pendingAccountRequests: pendingAccRequests, pendingRegistrationRequests: pendingRegRequests, pendingLeaves, branchWise };
      }

      case "get_global_defaulter_list": {
        if (!isAdmin && !isFaculty) return { error: 'Admin/Faculty only.' };
        const threshold = args.threshold || 75;
        let q = { role: 'student' };
        if (args.branch) q.branch = args.branch.toUpperCase();
        const students = await User.find(q).select('rollNo name branch');
        const defaulters = [];
        for (const s of students) {
          const summary = await getStudentSummary(s.rollNo);
          if (summary && summary.attendancePercentage < threshold) {
            defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, percentage: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures });
          }
        }
        defaulters.sort((a, b) => a.percentage - b.percentage);
        if (args.format === 'pdf') {
          const rows = defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.percentage}%`]);
          const pdfBuffer = await generatePDFBuffer({
            title: `Global Defaulter Report (< ${threshold}%)`,
            subtitle: `Date: ${getISTDateString(new Date())} | Total: ${defaulters.length}`,
            sections: [{ heading: 'Defaulters', table: { headers: ['Roll', 'Name', 'Branch', 'P/T', '%'], rows } }]
          });
          return { success: true, count: defaulters.length, filename: `defaulters_${threshold}.pdf`, pdfBase64: pdfBuffer.toString('base64') };
        }
        return { count: defaulters.length, threshold, defaulters: defaulters.slice(0, 100) };
      }

      case "generate_report_pdf": {
        if (isStudent) return { error: 'Students cannot generate admin reports.' };
        const { reportType, filters } = args;
        const f = filters || {};
        if (reportType === 'student_attendance') {
          const target = f.rollNo || rollNo;
          const targetUser = await User.findOne({ rollNo: target.toUpperCase() });
          if (!targetUser) return { error: 'Student not found.' };
          const summary = await getStudentSummary(target.toUpperCase());
          if (!summary) return { error: 'Cannot compute.' };
          const rows = Object.entries(summary.subjectStats).map(([sub, st]) => [sub, `${st.present}/${st.total}`, `${st.percentage}%`]);
          const pdfBuffer = await generatePDFBuffer({
            title: `Student Attendance Report`,
            subtitle: `${targetUser.name} (${targetUser.rollNo}) • ${targetUser.branch || 'CSE'} • ${summary.attendancePercentage}%`,
            sections: [
              { heading: 'Summary', bullets: [`Overall: ${summary.attendancePercentage}%`, `Attended: ${summary.totalAcademicLectures}/${summary.totalConductedLectures}`, `Days Present: ${summary.daysPresent}`] },
              { heading: 'Subject-wise', table: { headers: ['Subject', 'P/T', '%'], rows } }
            ]
          });
          return { success: true, filename: `attendance_${target}.pdf`, pdfBase64: pdfBuffer.toString('base64'), message: 'PDF ready.' };
        }
        if (reportType === 'defaulter_list') {
          const threshold = f.threshold || 75;
          const students = await User.find({ role: 'student' }).select('rollNo name branch');
          const defaulters = [];
          for (const s of students) {
            const summary = await getStudentSummary(s.rollNo);
            if (summary && summary.attendancePercentage < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures });
          }
          defaulters.sort((a, b) => a.pct - b.pct);
          const rows = defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.pct}%`]);
          const pdfBuffer = await generatePDFBuffer({
            title: `Defaulter Report (< ${threshold}%)`,
            subtitle: `Total: ${defaulters.length} | Date: ${getISTDateString(new Date())}`,
            sections: [{ heading: 'Defaulters', table: { headers: ['Roll', 'Name', 'Branch', 'P/T', '%'], rows } }]
          });
          return { success: true, filename: `defaulters.pdf`, pdfBase64: pdfBuffer.toString('base64'), message: `${defaulters.length} defaulters.` };
        }
        return { error: 'Unknown reportType.' };
      }

      case "get_audit_logs": {
        if (!isAdmin) return { error: 'Admin only.' };
        const limit = Math.min(args.limit || 30, 200);
        const filter = {};
        if (args.performedBy) filter.performedBy = args.performedBy.toUpperCase();
        if (args.actionType) filter.actionType = args.actionType;
        const logs = await AuditLog.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
        return { count: logs.length, logs: logs.map(l => ({ performedBy: l.performedBy, role: l.performedByRole, action: l.actionType, targetId: l.targetId, at: l.timestamp, details: l.details })) };
      }

      case "send_broadcast_notice": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { targetGroup, title, message } = args;
        if (!message) return { error: 'message required.' };
        const nn = await Notice.create({
          title: title || 'Broadcast',
          message,
          category: targetGroup || 'general',
          targetGroup: targetGroup || 'all',
          authorRollNo: rollNo
        });
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'send_broadcast_notice', details: { targetGroup, title } });
        return { success: true, noticeId: nn._id, message: `✅ Broadcast sent to ${targetGroup || 'all'}.` };
      }

      // ==================== LEGACY / UTILITY ====================
      case "get_pending_registration_requests": {
        if (!isAdmin) return { error: 'Admin only.' };
        const requests = await RegistrationRequest.find({ status: 'Pending' }).sort({ createdAt: -1 }).limit(50).lean();
        return { count: requests.length, requests: requests.map(r => ({ _id: r._id, name: r.name, rollNo: r.rollNo, role: r.role, branch: r.branch, subject: r.subject, createdAt: r.createdAt })) };
      }

      case "review_registration_request": {
        if (!isAdmin) return { error: 'Admin only.' };
        const { requestId, action, note } = args;
        if (!requestId || !action) return { error: 'requestId and action required.' };
        if (!['Approved', 'Rejected'].includes(action)) return { error: 'Invalid action.' };
        const regReq = await RegistrationRequest.findById(requestId);
        if (!regReq) return { error: 'Not found.' };
        if (regReq.status !== 'Pending') return { error: `Already ${regReq.status}.` };
        if (action === 'Rejected') {
          regReq.status = 'Rejected'; regReq.reviewedBy = rollNo; regReq.adminNote = note || '';
          await regReq.save();
          await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'reject_registration', targetId: requestId, details: { rollNo: regReq.rollNo } });
          return { success: true, message: `Rejected.` };
        }
        const existing = await User.findOne({ rollNo: regReq.rollNo });
        if (existing) {
          regReq.status = 'Rejected'; regReq.reviewedBy = rollNo; regReq.adminNote = 'User exists';
          await regReq.save();
          return { error: `User ${regReq.rollNo} already exists.` };
        }
        const newUser = new User({ name: regReq.name, rollNo: regReq.rollNo, password: regReq.password, role: regReq.role, boundDeviceId: regReq.deviceId, branch: regReq.branch, section: regReq.section, facultySubject: regReq.subject });
        await newUser.save();
        if (regReq.role === 'faculty' && regReq.subject) {
          await TeacherSubject.create({ teacherRollNo: regReq.rollNo, subject: mapToCanonical(regReq.subject), assignedBy: rollNo });
        }
        regReq.status = 'Approved'; regReq.reviewedBy = rollNo; regReq.adminNote = note || ''; regReq.approvedUserRollNo = regReq.rollNo;
        await regReq.save();
        await logAudit({ performedBy: rollNo, performedByRole: role, actionType: 'approve_registration', targetId: requestId, details: { rollNo: regReq.rollNo, role: regReq.role } });
        return { success: true, message: `✅ ${regReq.role} ${regReq.name} approved.` };
      }

      case "get_pending_requests_summary": {
        if (!isAdmin) return { error: 'Admin only.' };
        const attendancePending = await AttendanceRequest.countDocuments({ status: 'Pending' });
        const accountPending = await AccountRequest.countDocuments({ status: 'Pending' });
        const leavesPending = await Leave.countDocuments({ status: 'Pending' });
        const registrationPending = await RegistrationRequest.countDocuments({ status: 'Pending' });
        return { attendance: { pending: attendancePending }, accountRequests: { pending: accountPending }, leaves: { pending: leavesPending }, registration: { pending: registrationPending } };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`Tool ${toolName} error:`, err);
    return { error: `Execution failed: ${err.message}` };
  }
}

// ============================================================
//  DYNAMIC SYSTEM PROMPT
// ============================================================
function buildSystemPrompt(user) {
  const todayStr = getISTDateString(new Date());
  const currentTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const roleUpper = (user.role || 'student').toUpperCase();
  const toolsList = BOT_TOOLS.map(t => `- ${t.name}: ${t.description}`).join('\n');

  return `You are "BM Bot", an autonomous AI ERP Assistant for BM Group of Institutions.

## CURRENT CONTEXT
Today: ${todayStr} | Time: ${currentTime} IST
College Hours: 09:20 AM – 03:00 PM IST

## USER
Name: ${user.name} | Roll: ${user.rollNo} | Role: ${roleUpper} | Branch: ${user.branch || 'CSE'} | Section: ${user.section || '5'}

## ROLE PERMISSIONS
- STUDENT: Own attendance, bunk stats, timetable, submit requests, apply leave, notices, download own PDF
- FACULTY: Assigned subjects, class summary, defaulter list, review requests, bulk mark, faculty timetable, class PDF
- ADMIN: Full access — user mgmt, force attendance, holidays, faculty assignment, timetable, analytics, audit logs, broadcasts, registrations

## AVAILABLE TOOLS
When user's request needs DB/action, emit a tool call in EXACTLY this format:

\`\`\`json_tool
{"name": "tool_name", "args": {"key": "value"}}
\`\`\`

Tools:
${toolsList}

## CRITICAL RULES
1. **Language Mirroring**: Reply in EXACT SAME language as user (Hindi/Hinglish/English).
2. **Tool Use**: For DB/action requests, EMIT TOOL CALL. Don't hallucinate.
3. **No Fabrication**: Never invent IDs, dates, numbers.
4. **After Tool Result**: Format into clean answer with bullets.
5. **Formatting**: Bullets only. NO markdown tables.
6. **Security**: Refuse role-violating requests politely.
7. **Concise**: Keep short and actionable.
8. If no tool needed (greetings, general Q), just reply directly.

## EXAMPLES
- "meri attendance" → get_student_summary {"rollNo": "${user.rollNo}"}
- "kitne bunk" → get_bunk_advisor {"rollNo": "${user.rollNo}", "targetPercentage": 75}
- "kal ka timetable" → get_timetable {"date": "${todayStr}"}
- "pending registrations" (admin) → get_pending_registration_requests {}
- "college analytics" (admin) → get_college_analytics {}
- "audit logs" (admin) → get_audit_logs {"limit": 30}
- "system status" (admin) → (no tool, just reply)
- General knowledge → reply directly, no tool.

Now respond to user.`;
}

// ============================================================
//  ROUTES
// ============================================================
app.get('/', (req, res) => res.send('BM Group ERP Active!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: { primary: { provider: 'groq', model: GROQ_MODEL, keys: GROQ_API_KEYS.length }, fallback: { provider: 'gemini', model: GEMINI_MODEL, keys: GEMINI_API_KEYS.length } },
  tools: BOT_TOOLS.length,
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
    let facultySubjectCanon = null;
    if (role === 'faculty') {
      if (!subject) return res.status(400).json({ error: 'Subject required for faculty.' });
      facultySubjectCanon = mapToCanonical(subject);
      if (!cleanRoll || cleanRoll === 'AUTO' || cleanRoll === '') cleanRoll = await generateTeacherId(subject);
    }
    const existingUser = await User.findOne({ rollNo: cleanRoll });
    if (existingUser) return res.status(400).json({ error: 'ID already registered! Please login.' });
    const existingPending = await RegistrationRequest.findOne({ rollNo: cleanRoll, status: 'Pending' });
    if (existingPending) return res.status(400).json({ error: 'Registration already pending.' });
    await RegistrationRequest.deleteMany({ rollNo: cleanRoll, status: 'Rejected' });
    const hashedPassword = await bcrypt.hash(password, 10);
    let branch = 'CSE';
    if (role === 'student' && cleanRoll.includes('AIDS')) branch = 'AIDS';
    const regReq = await RegistrationRequest.create({
      name, rollNo: cleanRoll, password: hashedPassword, deviceId: deviceId || null,
      role, branch, subject: facultySubjectCanon, status: 'Pending'
    });
    await logAudit({ performedBy: cleanRoll, performedByRole: role, actionType: 'registration_submitted', targetId: regReq._id.toString(), details: { name, role } });
    res.status(201).json({
      message: `✅ Registration submitted! Admin approval pending. Login milega approval ke baad.`,
      requestId: regReq._id, rollNo: cleanRoll, status: 'Pending'
    });
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
      const pendingReg = await RegistrationRequest.findOne({ rollNo: cleanRoll, status: 'Pending' });
      if (pendingReg) return res.status(403).json({ error: `⏳ Registration pending admin approval.`, code: 'REGISTRATION_PENDING' });
      const rejectedReg = await RegistrationRequest.findOne({ rollNo: cleanRoll, status: 'Rejected' }).sort({ updatedAt: -1 });
      if (rejectedReg) return res.status(403).json({ error: `❌ Registration rejected.${rejectedReg.adminNote ? ' Reason: ' + rejectedReg.adminNote : ''}`, code: 'REGISTRATION_REJECTED' });
      return res.status(400).json({ error: 'User not found! Please register first.' });
    }
    if (user.isActive === false) return res.status(403).json({ error: 'Account deactivated. Contact admin.' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    user.failedAttempts = 0; user.blockUntil = null;
    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { user.boundDeviceId = deviceId; await user.save(); }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) return res.status(403).json({ error: 'Unauthorized device!' });
    }
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token; await user.save();
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role: user.role, branch: user.branch, section: user.section } });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ========== ACCOUNT ==========
app.post('/api/auth/forgot-password-request', async (req, res) => {
  try {
    const { rollNo, reason } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found' });
    const existing = await AccountRequest.findOne({ rollNo: cr, type: 'forgot_password', status: 'Pending' });
    if (existing) return res.status(400).json({ error: 'Already pending' });
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
    if (!ok) return res.status(400).json({ error: 'Current password incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Too short' });
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
    if (!approved) return res.status(403).json({ error: 'No approved request.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Too short' });
    await User.updateOne({ rollNo: cr }, { $set: { password: await bcrypt.hash(newPassword, 10) } });
    approved.status = 'Used'; await approved.save();
    res.json({ message: 'Password updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/account-requests/check/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const requests = await AccountRequest.find({ rollNo: cr }).sort({ createdAt: -1 }).limit(10);
    res.json({ count: requests.length, requests });
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
    if (action === 'Approved' && r.type === 'device_reset') await User.updateOne({ rollNo: r.rollNo }, { $set: { boundDeviceId: null } });
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'review_account_request_endpoint', targetId: r._id.toString(), details: { action, type: r.type } });
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'admin_reset_password', targetId: targetRollNo });
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'admin_reset_device', targetId: targetRollNo });
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'update_rollno', details: { oldRoll, newRoll } });
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'delete_user', targetId: t });
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'impersonate', targetId: targetRollNo });
    res.json({ message: `As ${student.name}`, token, user: { name: student.name, rollNo: student.rollNo, role: 'student' }, isImpersonating: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- REGISTRATION REQUESTS ----------
app.get('/api/admin/registration-requests/:adminRollNo', async (req, res) => {
  try {
    const admin = await User.findOne({ rollNo: req.params.adminRollNo.trim().toUpperCase() });
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    const status = req.query.status || 'Pending';
    const filter = status === 'All' ? {} : { status };
    const requests = await RegistrationRequest.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json({ count: requests.length, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/registration-requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note } = req.body;
    const admin = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
    const regReq = await RegistrationRequest.findById(req.params.id);
    if (!regReq) return res.status(404).json({ error: 'Not found.' });
    if (regReq.status !== 'Pending') return res.status(400).json({ error: `Already ${regReq.status}.` });
    if (action === 'Rejected') {
      regReq.status = 'Rejected'; regReq.reviewedBy = admin.rollNo; regReq.adminNote = note || '';
      await regReq.save();
      return res.json({ message: `Rejected for ${regReq.name}.`, request: regReq });
    }
    const existing = await User.findOne({ rollNo: regReq.rollNo });
    if (existing) {
      regReq.status = 'Rejected'; regReq.reviewedBy = admin.rollNo; regReq.adminNote = 'User exists';
      await regReq.save();
      return res.status(400).json({ error: `User ${regReq.rollNo} exists.` });
    }
    const newUser = new User({ name: regReq.name, rollNo: regReq.rollNo, password: regReq.password, role: regReq.role, boundDeviceId: regReq.deviceId, branch: regReq.branch, section: regReq.section, facultySubject: regReq.subject });
    await newUser.save();
    if (regReq.role === 'faculty' && regReq.subject) await TeacherSubject.create({ teacherRollNo: regReq.rollNo, subject: mapToCanonical(regReq.subject), assignedBy: admin.rollNo });
    regReq.status = 'Approved'; regReq.reviewedBy = admin.rollNo; regReq.adminNote = note || ''; regReq.approvedUserRollNo = regReq.rollNo;
    await regReq.save();
    res.json({ message: `✅ ${regReq.role} ${regReq.name} approved.`, user: { name: newUser.name, rollNo: newUser.rollNo, role: newUser.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE REQUEST ==========
app.post('/api/requests/submit', async (req, res) => {
  try {
    const { rollNo, date, lectureType, subject, subjects, period, reason } = req.body;
    if (!rollNo || !date || !lectureType) return res.status(400).json({ error: 'Required fields missing.' });
    if (!['full_day', 'single_lecture'].includes(lectureType)) return res.status(400).json({ error: 'Invalid lectureType.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr, role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const todayStr = getISTDateString(new Date());
    if (date > todayStr) return res.status(400).json({ error: `🚫 Future date not allowed.` });
    if (date === todayStr && getISTHour(new Date()) < COLLEGE_CLOSE_HOUR) return res.status(400).json({ error: `⏰ Today's request only after 3 PM.` });
    const ds = await checkDateStatus(date);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    if (lectureType !== 'full_day' && !subject) return res.status(400).json({ error: 'subject required.' });
    const existing = await AttendanceRequest.findOne({ rollNo: cr, date, lectureType, status: 'Pending' });
    if (existing) return res.status(400).json({ error: `Already pending for ${date}.` });
    const isPast = date < todayStr;
    const newReq = await AttendanceRequest({
      rollNo: cr, studentName: user.name, branch: user.branch || 'CSE',
      date, lectureType,
      subject: subject ? mapToCanonical(subject) : null,
      subjects: (subjects || []).map(mapToCanonical),
      period: period || null,
      reason: reason || `Attendance request`,
      isPastDate: isPast, status: 'Pending'
    });
    await newReq.save();
    res.status(201).json({ message: `✅ Request submitted.`, request: newReq });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LIVE MARKING ==========
app.post('/api/attendance/mark-live', async (req, res) => {
  try {
    const { rollNo, latitude, longitude, passcode, type, subject } = req.body;
    if (!rollNo || !passcode || !type) return res.status(400).json({ error: 'Required fields.' });
    if (!['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Student not found.' });
    const branch = user.branch || 'CSE';
    const section = user.section || '5';
    const todayStr = getISTDateString(new Date());
    const ds = await checkDateStatus(todayStr);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    if (getISTHour(new Date()) >= COLLEGE_CLOSE_HOUR) return res.status(400).json({ error: `College hours over.` });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `❌ ${lc.distance}m away.` }); }
    const passDoc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() }, enabled: true });
    if (!passDoc) return res.status(400).json({ error: '❌ Invalid/expired passcode.' });
    if (type === 'full_day') {
      const tt = getTimetableForBranch(branch, section);
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = days[new Date().getDay()];
      const acadSet = new Set();
      (tt[dayName] || []).forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Sports")) acadSet.add(s); });
      const acad = Array.from(acadSet);
      if (!acad.length) return res.status(400).json({ error: 'No academic subjects today.' });
      let marked = 0, skipped = 0;
      for (const sub of acad) {
        try { await Attendance.create({ rollNo: cr, studentName: user.name, subject: sub, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); marked++; }
        catch (e) { if (e.code === 11000) skipped++; else throw e; }
      }
      user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
      user.failedAttempts = 0; user.blockUntil = null; await user.save();
      if (marked === 0) return res.status(400).json({ error: `Already marked.` });
      return res.status(201).json({ message: `✅ ${marked} marked (${skipped} already).`, marked, skipped });
    }
    const period = getCurrentPeriod(branch, section);
    if (!period) return res.status(400).json({ error: '⏰ No active lecture.' });
    const activeSubj = mapToCanonical(period.subject);
    try { await Attendance.create({ rollNo: cr, studentName: user.name, subject: activeSubj, date: todayStr, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); }
    catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    res.status(201).json({ message: `✅ ${activeSubj} marked.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== REQUESTS VIEW ==========
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
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Access denied.' });
    let filter = {};
    if (req1.role === 'faculty') filter.branch = req1.branch || 'CSE';
    if (req.query.status) filter.status = req.query.status;
    if (req.query.rollNo) filter.rollNo = req.query.rollNo.trim().toUpperCase();
    if (req.query.date) filter.date = req.query.date;
    const requests = await AttendanceRequest.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ count: requests.length, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, note, approvedSubjects } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Access denied.' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
    const request = await AttendanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found.' });
    if (request.status !== 'Pending') return res.status(400).json({ error: `Already ${request.status}.` });
    if (action === 'Approved') {
      const b = request.branch || 'CSE';
      const dateStatus = await checkDateStatus(request.date);
      if (dateStatus.isBlocked) return res.status(400).json({ error: `Date blocked.` });
      const schedule = getScheduleForDate(request.date, b);
      let subjectsToMark = [];
      if (request.lectureType === 'full_day') subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
      else if (request.lectureType === 'single_lecture') subjectsToMark = request.subject ? [mapToCanonical(request.subject)] : [];
      if (approvedSubjects && approvedSubjects.length > 0) subjectsToMark = approvedSubjects.map(mapToCanonical);
      let markedCount = 0; const markedSubjects = [];
      for (const sub of subjectsToMark) {
        try { const exists = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date });
          if (!exists) { await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: null, ipAddress: 'request-approved', isVerified: false, branch: b }); markedCount++; markedSubjects.push(sub); }
        } catch (e) {}
      }
      request.status = markedSubjects.length === subjectsToMark.length ? 'Approved' : 'Partially Approved';
      request.reviewedBy = req1.rollNo; request.adminNote = note || ''; request.facultyNote = note || '';
      request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: markedSubjects });
      await request.save();
      res.json({ message: `✅ Approved. ${markedCount} marked.`, markedCount, markedSubjects });
    } else {
      request.status = 'Rejected'; request.reviewedBy = req1.rollNo; request.adminNote = note || ''; request.facultyNote = note || '';
      request.reviewHistory.push({ action: 'Rejected', by: req1.rollNo, at: new Date(), note: note || '' });
      await request.save();
      res.json({ message: `❌ Rejected.` });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
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
          await request.save(); results.push({ id, status: 'Rejected' });
        } else {
          const b = request.branch || 'CSE';
          const schedule = getScheduleForDate(request.date, b);
          let subjectsToMark = [];
          if (request.lectureType === 'full_day') subjectsToMark = [...new Set(schedule.schedule.filter(s => !s.subject.includes('LIB') && !s.subject.includes('Sports') && s.period !== 'LUNCH').map(s => mapToCanonical(s.subject)))];
          else if (request.lectureType === 'single_lecture' && request.subject) subjectsToMark = [mapToCanonical(request.subject)];
          let marked = 0;
          for (const sub of subjectsToMark) {
            try { const ex = await Attendance.findOne({ rollNo: request.rollNo, subject: sub, date: request.date });
              if (!ex) { await Attendance.create({ rollNo: request.rollNo, studentName: request.studentName, subject: sub, date: request.date, status: 'Present', location: null, ipAddress: 'bulk-approve', isVerified: false, branch: b }); marked++; }
            } catch (e) {}
          }
          request.status = 'Approved'; request.reviewedBy = req1.rollNo; request.adminNote = note || '';
          request.reviewHistory.push({ action: 'Approved', by: req1.rollNo, at: new Date(), note: note || '', reviewedSubjects: subjectsToMark });
          await request.save(); totalMarked += marked; results.push({ id, status: 'Approved', marked });
        }
      } catch (e) { results.push({ id, error: e.message }); }
    }
    res.json({ message: `Bulk done. ${totalMarked} marked.`, results });
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'toggle_passcode_system_endpoint', details: { enabled } });
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
    const { requesterRollNo, teacherRollNo, subject, branch, section } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const ct = teacherRollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: ct, role: 'faculty' });
    if (!teacher) return res.status(404).json({ error: 'Faculty not found!' });
    const canon = mapToCanonical(subject);
    if (await TeacherSubject.findOne({ teacherRollNo: ct, subject: canon })) return res.status(400).json({ error: 'Already assigned.' });
    await TeacherSubject.create({ teacherRollNo: ct, subject: canon, branch: branch || teacher.branch || 'CSE', section: section || teacher.section || 'A', assignedBy: requesterRollNo });
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'assign_subject', targetId: ct, details: { subject: canon, branch, section } });
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
    if (!lc.isInside) return res.status(400).json({ error: `Outside.` });
    if (!studentRollNo) return res.status(400).json({ error: 'Student roll required.' });
    const cs = studentRollNo.trim().toUpperCase();
    const su = await User.findOne({ rollNo: cs, role: 'student' });
    if (!su) return res.status(404).json({ error: 'Student not found!' });
    if (await Attendance.findOne({ rollNo: cs, subject: subj, date: todayDate })) return res.status(400).json({ error: 'Already marked.' });
    await new Attendance({ rollNo: cs, studentName: su.name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: su.branch || 'CSE' }).save();
    res.status(201).json({ message: `✅ Marked ${su.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/teacher/bulk-mark-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates, status } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase(), role: 'faculty' });
    if (!req1) return res.status(403).json({ error: 'Faculty only.' });
    if (!studentRollNos || !studentRollNos.length) return res.status(400).json({ error: 'Roll nos required.' });
    if (!dates || !dates.length) return res.status(400).json({ error: 'Dates required.' });
    const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject');
    if (!subjects.length) return res.status(400).json({ error: 'No subjects assigned.' });
    const students = await User.find({ rollNo: { $in: studentRollNos }, role: 'student' });
    const results = []; let totalMarked = 0, totalSkipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE'; const sec = s.section || '5';
      let mk = 0, sk = 0;
      for (const date of dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        const dayName = ds.dayName;
        const daySubjects = (getTimetableForBranch(b, sec)[dayName] || []).map(mapToCanonical).filter(x => subjects.includes(x));
        const uniq = [...new Set(daySubjects.filter(x => !x.includes('LIB') && !x.includes('Sports')))];
        for (const sub of uniq) {
          try {
            const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date });
            if (!ex) { await Attendance.create({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: status || 'Present', location: null, ipAddress: 'fac-bulk', isVerified: false, branch: b }); mk++; }
            else sk++;
          } catch (err) { if (err.code === 11000) sk++; else throw err; }
        }
      }
      results.push({ rollNo: s.rollNo, marked: mk, skipped: sk });
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
    const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo.trim().toUpperCase() }).distinct('subject');
    if (!subjects.length) return res.status(400).json({ error: 'No subjects assigned.' });
    const r = await Attendance.deleteMany({ rollNo: { $in: studentRollNos }, date: { $in: dates }, subject: { $in: subjects } });
    res.json({ message: `✅ Deleted ${r.deletedCount}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PASSCODE GENERATE ==========
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type, force, publish, durationMinutes, isPublic } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'User not found!' });
    if (req1.role === 'admin') {}
    else if (req1.role === 'faculty' && type === 'single_lecture') {}
    else return res.status(403).json({ error: 'Access Denied.' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const todayStr = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayStr);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message, blocked: true });
    const publishFlag = !!publish;
    const pubPublic = isPublic === undefined ? true : !!isPublic;
    const now = new Date();
    const durationMin = parseInt(durationMinutes) || (type === 'full_day' ? 1440 : 30);
    const branch = req1.branch || 'CSE';
    const section = req1.section || '5';

    if (type === 'single_lecture') {
      const period = getCurrentPeriod(branch, section);
      if (!period) return res.status(400).json({ error: 'No active lecture.' });
      const ds = getISTDateString(now);
      const key = `single_lecture_${ds}_${period.start}`;
      if (publishFlag && !force) {
        const existing = await Passcode.findOne({ key, type: 'single_lecture', enabled: true, published: false, expiresAt: { $gt: new Date() } });
        if (existing) {
          existing.published = true; existing.publishedAt = now; existing.publishedBy = req1.rollNo; existing.durationMinutes = durationMin;
          existing.expiresAt = new Date(now.getTime() + durationMin * 60 * 1000);
          await existing.save();
          return res.json({ message: 'Published', passcode: existing.passcode, type, expiresAt: existing.expiresAt, published: true, isPublic: pubPublic, durationMinutes: durationMin });
        }
      }
      await Passcode.deleteMany({ key, type: 'single_lecture' });
      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const expiry = new Date(now.getTime() + durationMin * 60 * 1000);
      const newDoc = await new Passcode({ passcode, type, key, expiresAt: expiry, published: publishFlag, isPublic: pubPublic, enabled: true, publishedAt: publishFlag ? now : null, publishedBy: publishFlag ? req1.rollNo : null, durationMinutes: publishFlag ? durationMin : null }).save();
      await Passcode.deleteMany({ type: 'single_lecture', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : (publishFlag ? 'Published' : 'Generated'), passcode: newDoc.passcode, type, expiresAt: newDoc.expiresAt, published: publishFlag, isPublic: pubPublic, durationMinutes: durationMin });
    }
    if (type === 'full_day') {
      const ds = getISTDateString(now);
      const key = `full_day_${ds}`;
      if (publishFlag && !force) {
        const existing = await Passcode.findOne({ key, type: 'full_day', enabled: true, published: false, expiresAt: { $gt: new Date() } });
        if (existing) {
          existing.published = true; existing.publishedAt = now; existing.publishedBy = req1.rollNo; existing.durationMinutes = durationMin;
          existing.expiresAt = new Date(now.getTime() + durationMin * 60 * 1000);
          await existing.save();
          return res.json({ message: 'Published', passcode: existing.passcode, type, expiresAt: existing.expiresAt, published: true, isPublic: pubPublic, durationMinutes: durationMin });
        }
      }
      await Passcode.deleteMany({ key, type: 'full_day' });
      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiry = publishFlag ? new Date(now.getTime() + durationMin * 60 * 1000) : (() => { const e = new Date(now); e.setHours(23, 59, 59, 999); return e; })();
      const newDoc = await new Passcode({ passcode, type, key, expiresAt: expiry, published: publishFlag, isPublic: pubPublic, enabled: true, publishedAt: publishFlag ? now : null, publishedBy: publishFlag ? req1.rollNo : null, durationMinutes: publishFlag ? durationMin : null }).save();
      await Passcode.deleteMany({ type: 'full_day', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : (publishFlag ? 'Published' : 'Generated'), passcode: newDoc.passcode, type, expiresAt: newDoc.expiresAt, published: publishFlag, isPublic: pubPublic, durationMinutes: durationMin });
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
    const period = getCurrentPeriod(req1.branch || 'CSE', req1.section || '5');
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
    if (!doc) return res.json({ passcode: null, message: 'No published passcode.' });
    res.json({ passcode: doc.passcode, type, expiresAt: doc.expiresAt, durationMinutes: doc.durationMinutes, publishedAt: doc.publishedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEGACY MARKING ============
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
    const period = getCurrentPeriod(user.branch || 'CSE', user.section || '5');
    if (!period) return res.status(400).json({ error: 'No active period.' });
    const ns = mapToCanonical(subject), nc = mapToCanonical(period.subject);
    if (ns !== nc) return res.status(400).json({ error: 'Subject mismatch.' });
    const key = `single_lecture_${todayDate}_${period.start}`;
    const doc = await Passcode.findOne({ key, type: 'single_lecture', passcode, expiresAt: { $gt: new Date() }, enabled: true });
    if (!doc) return res.status(400).json({ error: 'Invalid/expired passcode.' });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `Outside.` }); }
    try { await new Attendance({ rollNo: cr, studentName: user.name, subject: ns, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: user.branch || 'CSE' }).save(); }
    catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    res.status(201).json({ message: `✅ Marked!` });
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
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `Outside.` }); }
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const branch = user.branch || 'CSE';
    const section = user.section || '5';
    const tt = getTimetableForBranch(branch, section);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[new Date().getDay()];
    const acadSet = new Set();
    (tt[dayName] || []).forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Sports")) acadSet.add(s); });
    const acad = Array.from(acadSet);
    let marked = 0, skipped = 0;
    for (const sub of acad) {
      try { await Attendance.create({ rollNo: cr, studentName: name, subject: sub, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); marked++; }
      catch (err) { if (err.code === 11000) skipped++; else throw err; }
    }
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null; await user.save();
    if (marked === 0 && skipped > 0) return res.status(400).json({ error: `All already marked.` });
    if (marked === 0) return res.status(400).json({ error: 'No academic subjects today.' });
    res.status(201).json({ message: `✅ Marked ${marked} new.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== NOTICES ==========
app.get('/api/notices', async (req, res) => {
  try { res.json(await Notice.find().sort({ date: -1 }).limit(10)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message, targetGroup } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!message || message.trim() === "") { await Notice.deleteMany({}); return res.json({ message: 'Cleared!' }); }
    const nn = await new Notice({ title: title || 'Announcement', message, targetGroup: targetGroup || 'all', authorRollNo: requesterRollNo }).save();
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'publish_notice', details: { title, targetGroup } });
    res.status(201).json({ message: 'Published!', notice: nn });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HOLIDAYS ==========
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason, affectBranches } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const parts = date.split('-');
    const dobj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dobj < SEMESTER_START) return res.status(400).json({ error: 'Before semester!' });
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dn = days[dobj.getDay()];
    if (dn === 'Saturday' || dn === 'Sunday') return res.status(400).json({ error: 'Weekend!' });
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'Holiday', declaredBy: requesterRollNo, affectBranches: affectBranches || ['ALL'] }, { upsert: true, new: true });
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'declare_holiday', details: { date, reason, affectBranches } });
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
    const pendingRegistrations = await RegistrationRequest.countDocuments({ status: 'Pending' });
    res.json({ totalStudents, todayPresent, todayAbsent: absent.length, overallAttendance: totalAtt, overallPct, todayPresentStudents: presentList, workingDaysSoFar, totalWorkingDaysSemester, pendingRequests, pendingRegistrations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/all-users/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await User.find().select('name rollNo role boundDeviceId email phone semester branch section profilePic facultySubject isActive').sort({ rollNo: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/faculty/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    res.json(await User.find({ role: 'faculty' }).select('name rollNo email phone facultySubject').sort({ rollNo: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== AUDIT LOGS ENDPOINT ==========
app.get('/api/admin/audit-logs/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const filter = {};
    if (req.query.performedBy) filter.performedBy = req.query.performedBy.toUpperCase();
    if (req.query.actionType) filter.actionType = req.query.actionType;
    const logs = await AuditLog.find(filter).sort({ timestamp: -1 }).limit(limit);
    res.json({ count: logs.length, logs });
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
    await logAudit({ performedBy: rrn, performedByRole: req1.role, actionType: 'delete_attendance_record', targetId: req.params.id, details: { rollNo: rec.rollNo, subject: rec.subject, date: rec.date } });
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
    rec.status = status; await rec.save();
    await logAudit({ performedBy: requesterRollNo, performedByRole: req1.role, actionType: 'update_attendance_record', targetId: req.params.id, details: { status, rollNo: rec.rollNo } });
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
    if (month === undefined || isNaN(parseInt(month))) return res.status(400).json({ error: 'Month required' });
    const m = parseInt(month);
    if (m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const branch = user.branch || 'CSE';
    const section = user.section || '5';
    const tt = getTimetableForBranch(branch, section);
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
        (tt[dayName] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (!sub.includes('Sports') && !sub.includes('LIB')) { subSet.add(sub); totalConducted++; } });
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
    const actualSection = user.section || '5';
    let marked = 0, markedSubs = [], already = [];
    const tt = getTimetableForBranch(actualBranch, actualSection);
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
      await new Attendance({ rollNo: tr, studentName: user.name, subject: sub, date, status: status || 'Present', location: null, ipAddress: 'admin-manual', isVerified: false, branch: actualBranch, overriddenBy: requesterRollNo }).save();
      marked++; markedSubs.push(sub);
    }
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'manual_attendance', targetId: tr, details: { date, subjects: markedSubs, status } });
    res.status(201).json({ message: `✅ Marked ${marked} for ${user.name}`, markedSubjects: markedSubs, alreadyMarked: already, total: marked });
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

// ========== STUDENT SUMMARY ENDPOINT ==========
app.get('/api/student/summary/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const summary = await getStudentSummary(cr);
    if (!summary) return res.status(500).json({ error: 'Failed' });
    const daysAbsent = Math.max(0, summary.workingDaysSoFar - summary.daysPresent);
    res.json({ ...summary, daysAbsent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/bunk-advisor/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const target = parseInt(req.query.target) || 75;
    const advisor = await getBunkAdvisor(cr, target);
    if (!advisor) return res.status(500).json({ error: 'Failed' });
    res.json(advisor);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== EXPORT ==========
app.get('/api/export/google-sheets/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const records = await Attendance.find().sort({ rollNo: 1, date: -1 });
    let csvOut = 'Roll No,Student Name,Subject,Date,Status,IP Address\n';
    records.forEach(r => { csvOut += `${r.rollNo},${r.studentName},${mapToCanonical(r.subject)},${r.date},${r.status},${r.ipAddress || 'N/A'}\n`; });
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
    let csvOut = `Student Attendance Report\nStudent: ${sName} (${cs})\nRange: ${startStr} to ${endStr}\n\nDate,Subject,Status\n`;
    records.forEach(r => { csvOut += `${r.date},${mapToCanonical(r.subject)},${r.status}\n`; });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csvOut += `\nTotal: ${total}, Present: ${present}, %: ${pct}%\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cs}_${range}.csv`);
    res.send(csvOut);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== TIMETABLE ENDPOINTS ==========
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
    const section = req.query.section || '5';
    const tt = getTimetableForBranch(branch, section);
    const schedule = getScheduleForBranch(branch, section);
    res.json({ branch, section, timetable: tt, schedule });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/timetable/strict/:branch/:date', async (req, res) => {
  try {
    const branch = (req.params.branch || 'CSE').toUpperCase();
    const section = req.query.section || '5';
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const ds = await checkDateStatus(date);
    const text = getStrictTimetableResponse(date, branch, section);
    res.json({ branch, section, date, blocked: ds.isBlocked, type: ds.type || null, dayName: ds.dayName, formatted: text, schedule: ds.isBlocked ? [] : (getScheduleForDate(date, branch, section).schedule || []) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ADMIN: Update timetable endpoint ==========
app.post('/api/admin/update-timetable', async (req, res) => {
  try {
    const { requesterRollNo, branch, section, day, scheduleArray } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!branch || !day || !Array.isArray(scheduleArray)) return res.status(400).json({ error: 'branch, day, scheduleArray required.' });
    const sec = section || '5';
    const key = `${branch.toUpperCase()}_${sec}`;
    if (!DYNAMIC_SCHEDULE[key]) DYNAMIC_SCHEDULE[key] = JSON.parse(JSON.stringify((branch.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE));
    const dowNames = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    const dow = dowNames[day];
    if (dow === undefined) return res.status(400).json({ error: 'Invalid day.' });
    DYNAMIC_SCHEDULE[key][dow] = scheduleArray;
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'update_timetable_endpoint', details: { branch, section: sec, day, periods: scheduleArray.length } });
    res.json({ message: `✅ Timetable updated for ${branch}-${sec} on ${day}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== CLASS REPORT ==========
app.get('/api/admin/class-attendance-report', async (req, res) => {
  try {
    const { requesterRollNo, startDate, endDate, branch, section } = req.query;
    if (!requesterRollNo) return res.status(400).json({ error: 'requesterRollNo required' });
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only!' });
    const start = startDate ? new Date(startDate) : new Date(SEMESTER_START);
    let end = endDate ? new Date(endDate) : new Date(SEMESTER_END);
    const today = new Date();
    if (end > today) end = today;
    const sStr = getISTDateString(start), eStr = getISTDateString(end);
    let q = { role: 'student' };
    if (branch && branch !== 'ALL') q.branch = branch.toUpperCase();
    if (section) q.section = section;
    const students = await User.find(q).select('rollNo name branch section');
    if (!students.length) return res.json({ students: [], totalLectures: 0 });
    const holidays = await Holiday.find({ date: { $gte: sStr, $lte: eStr } });
    const holidaySet = new Set(holidays.map(h => (h.date || '').toString().split('T')[0]));
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const result = await Promise.all(students.map(async s => {
      const b = s.branch || 'CSE';
      const sec = s.section || '5';
      const tt = getTimetableForBranch(b, sec);
      let totalCond = 0;
      let cur = new Date(start);
      while (cur <= end) {
        const ds = getISTDateString(cur);
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
          (tt[dayNameMap[dow]] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (!sub.includes('Sports') && !sub.includes('LIB')) totalCond++; });
        }
        cur.setDate(cur.getDate() + 1);
      }
      const pc = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: sStr, $lte: eStr }, status: { $in: ['Present', 'Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      return { rollNo: s.rollNo, name: s.name, branch: b, section: sec, totalPresent: pc, totalLectures: totalCond, percentage: totalCond > 0 ? Math.round((pc / totalCond) * 100) : 0 };
    }));
    result.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));
    res.json({ students: result, totalLectures: result.length > 0 ? result[0].totalLectures : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== BULK MARK/DELETE (Admin) ==========
app.post('/api/admin/bulk-mark-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates, subjects } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    if (!studentRollNos || !studentRollNos.length) return res.status(400).json({ error: 'Roll nos required.' });
    if (!dates || !dates.length) return res.status(400).json({ error: 'Dates required.' });
    const students = await User.find({ rollNo: { $in: studentRollNos }, role: 'student' });
    const results = []; let tMarked = 0, tSkipped = 0;
    for (const s of students) {
      const b = s.branch || 'CSE'; const sec = s.section || '5';
      const tt = getTimetableForBranch(b, sec);
      let mk = 0, sk = 0;
      for (const date of dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        const dayName = ds.dayName;
        let toMark = subjects && subjects.length > 0 ? subjects : (tt[dayName] || []).map(x => mapToCanonical(x.subject));
        const uniq = [...new Set(toMark.filter(x => !x.includes('LIB') && !x.includes('Sports')))];
        for (const sub of uniq) {
          const ex = await Attendance.findOne({ rollNo: s.rollNo, subject: sub, date });
          if (!ex) { try { await new Attendance({ rollNo: s.rollNo, studentName: s.name, subject: sub, date, status: 'Present', location: null, ipAddress: 'bulk-mark', isVerified: false, branch: b }).save(); mk++; }
            catch (err) { if (err.code === 11000) sk++; else throw err; }
          } else sk++;
        }
      }
      results.push({ rollNo: s.rollNo, marked: mk, skipped: sk });
      tMarked += mk; tSkipped += sk;
    }
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'bulk_mark_attendance_endpoint', details: { tMarked, tSkipped } });
    res.json({ message: `✅ ${tMarked} new, ${tSkipped} skipped.`, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/bulk-delete-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const r = await Attendance.deleteMany({ rollNo: { $in: studentRollNos }, date: { $in: dates } });
    res.json({ message: `✅ Deleted ${r.deletedCount}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== CHAT ==========
app.get('/api/chats/:rollNo', async (req, res) => {
  try { res.json(await Chat.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ updatedAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/chats', async (req, res) => {
  try {
    const { rollNo, threadId, title, messages } = req.body;
    const cr = rollNo.trim().toUpperCase();
    if (!threadId) {
      const newTid = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const nc = await new Chat({ rollNo: cr, threadId: newTid, title: title || 'New Chat', messages: messages || [] }).save();
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
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEAVE ==========
app.post('/api/leave/apply', async (req, res) => {
  try {
    const { rollNo, fromDate, toDate, reason, leaveType, documentUrl } = req.body;
    if (!rollNo || !fromDate || !toDate || !reason) return res.status(400).json({ error: 'All fields required.' });
    const cr = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    if (new Date(toDate) < new Date(fromDate)) return res.status(400).json({ error: 'End before start.' });
    const leave = await new Leave({ rollNo: cr, studentName: user.name, fromDate, toDate, reason, leaveType: leaveType || 'Personal', documentUrl: documentUrl || null, branch: user.branch || 'CSE' });
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
      const sec = student?.section || '5';
      let cur = new Date(leave.fromDate);
      const end = new Date(leave.toDate);
      while (cur <= end) {
        const ds = getISTDateString(cur);
        const dsStatus = await checkDateStatus(ds);
        if (!dsStatus.isBlocked) {
          const tt = getTimetableForBranch(b, sec)[dsStatus.dayName] || [];
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
    await logAudit({ performedBy: requesterRollNo, performedByRole: 'admin', actionType: 'review_leave', targetId: leave._id.toString(), details: { action, student: leave.rollNo } });
    res.json({ message: `✅ Leave ${action.toLowerCase()} for ${leave.studentName}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DEFAULTERS ==========
app.get('/api/admin/defaulters/:requesterRollNo', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const threshold = parseInt(req.query.threshold) || 75;
    const students = await User.find({ role: 'student' }).select('rollNo name branch section');
    const defaulters = [];
    for (const s of students) {
      const summary = await getStudentSummary(s.rollNo);
      if (summary && summary.attendancePercentage < threshold) {
        defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, section: s.section, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures });
      }
    }
    defaulters.sort((a,b) => a.pct - b.pct);
    res.json({ threshold, defaulters });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ★★★ CHAT AGENT ENDPOINT ★★★
// ============================================================
app.post('/api/chat/agent', async (req, res) => {
  try {
    const { rollNo, message, threadId } = req.body;
    if (!rollNo || !message) return res.status(400).json({ error: 'rollNo and message required.' });
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const tId = threadId || `chat_${cleanRoll}_${Date.now()}`;
    let chatDoc = await Chat.findOne({ threadId: tId });
    if (!chatDoc) chatDoc = new Chat({ rollNo: cleanRoll, threadId: tId, messages: [], title: message.substring(0, 50) });
    chatDoc.messages.push({ role: 'user', content: message, timestamp: new Date() });
    const history = chatDoc.messages.slice(-8).map(m => ({ role: m.role, content: m.content }));
    const systemPrompt = buildSystemPrompt(user);

    let aiResult;
    try { aiResult = await callAI({ prompt: message, systemPrompt, history, maxTokens: 1500, temperature: 0.5 }); }
    catch (err) { await chatDoc.save(); return res.status(500).json({ error: 'AI failed: ' + err.message }); }

    let finalReply = aiResult.reply;
    let toolUsed = null;

    const toolCallMatch = finalReply.match(/```json_tool\s*([\s\S]*?)\s*```/);
    if (toolCallMatch) {
      try {
        const toolData = JSON.parse(toolCallMatch[1]);
        console.log(`🔧 [AGENT] Tool: ${toolData.name}`);
        const toolOutput = await executeBotTool(toolData.name, toolData.args || {}, {
          rollNo: user.rollNo, role: user.role, branch: user.branch, section: user.section, name: user.name
        });
        toolUsed = toolData.name;
        const followupPrompt = `Tool '${toolData.name}' result:\n${JSON.stringify(toolOutput, null, 2)}\n\nFormat this into clean user-friendly reply for ${user.name}. Bullets only, no markdown tables. Mirror the user's language. Be concise.`;
        try { const formatted = await callAI({ prompt: followupPrompt, systemPrompt, history: history.slice(-4), maxTokens: 1000, temperature: 0.3 }); finalReply = formatted.reply; }
        catch (err) { finalReply = `✅ Result:\n\n${JSON.stringify(toolOutput, null, 2)}`; }
      } catch (err) { finalReply = `⚠️ Tool error: ${err.message}`; }
    }

    chatDoc.messages.push({ role: 'assistant', content: finalReply, timestamp: new Date() });
    chatDoc.updatedAt = new Date();
    if (!chatDoc.title || chatDoc.title === 'New Chat') chatDoc.title = message.substring(0, 50);
    await chatDoc.save();

    res.json({ threadId: tId, reply: finalReply, provider: aiResult.provider, toolUsed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PDF EXPORT VIA CHAT ==========
app.post('/api/chat/export-pdf', async (req, res) => {
  try {
    const { rollNo, reportType, targetRollNo } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required.' });
    const user = await User.findOne({ rollNo: rollNo.trim().toUpperCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let pdfBuffer, filename;
    if (reportType === 'student_attendance') {
      const target = targetRollNo ? targetRollNo.trim().toUpperCase() : user.rollNo;
      if (user.role === 'student' && target !== user.rollNo) return res.status(403).json({ error: 'Own only.' });
      const targetUser = await User.findOne({ rollNo: target });
      if (!targetUser) return res.status(404).json({ error: 'Target not found.' });
      const summary = await getStudentSummary(target);
      const rows = Object.entries(summary.subjectStats).map(([sub, st]) => [sub, `${st.present}/${st.total}`, `${st.percentage}%`]);
      pdfBuffer = await generatePDFBuffer({
        title: `Attendance Report - ${targetUser.name}`,
        subtitle: `${targetUser.rollNo} • ${targetUser.branch || 'CSE'} • Overall: ${summary.attendancePercentage}%`,
        sections: [
          { heading: "Summary", bullets: [`Overall: ${summary.attendancePercentage}%`, `Attended: ${summary.totalAcademicLectures}/${summary.totalConductedLectures}`, `Days Present: ${summary.daysPresent}`] },
          { heading: "Subject-wise", table: { headers: ["Subject", "P/T", "%"], rows } }
        ]
      });
      filename = `attendance_${target}.pdf`;
    } else if (reportType === 'defaulter_list') {
      if (user.role === 'student') return res.status(403).json({ error: 'Only faculty/admin.' });
      const threshold = 75;
      const students = await User.find({ role: 'student' }).select('rollNo name branch');
      const defaulters = [];
      for (const s of students) {
        const summary = await getStudentSummary(s.rollNo);
        if (summary && summary.attendancePercentage < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures });
      }
      defaulters.sort((a, b) => a.pct - b.pct);
      const rows = defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.pct}%`]);
      pdfBuffer = await generatePDFBuffer({
        title: `Defaulter Report (< ${threshold}%)`,
        subtitle: `Date: ${getISTDateString(new Date())} | Total: ${defaulters.length}`,
        sections: [{ heading: "Defaulters", table: { headers: ["Roll", "Name", "Branch", "P/T", "%"], rows } }]
      });
      filename = `defaulters.pdf`;
    } else {
      return res.status(400).json({ error: 'Invalid reportType.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== LEGACY AI CHAT ==========
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId, useContext, useDatabase } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    const cr = rollNo?.trim().toUpperCase() || 'guest';
    let userData = null, existingChat = null;
    if (cr !== 'guest') {
      userData = await User.findOne({ rollNo: cr });
      if (threadId) existingChat = await Chat.findOne({ threadId, rollNo: cr });
    }
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';
    const userBranch = userData?.branch || branch || 'CSE';

    let contextStr = '';
    if (useContext === true && userData) {
      const todayStr = getISTDateString(new Date());
      contextStr = `Today: ${todayStr}\nUser: ${userData.name} (${userData.rollNo}, ${userData.role})\nBranch: ${userData.branch}`;
    }
    const systemPrompt = `You are "BM Bot". Role: ${userRole}. User: ${userName}. Reply in SAME language. Bullets only, no tables.${contextStr ? '\n---CONTEXT---\n' + contextStr : ''}`;
    let reply = '', aiOk = false, provider = 'unknown';
    try { const r = await callAI({ prompt: message, systemPrompt, history: existingChat?.messages, maxTokens: 1200, temperature: 0.5 }); reply = r.reply; provider = r.provider; aiOk = true; }
    catch (err) { reply = err.message; }
    let newThreadId = threadId;
    if (cr !== 'guest' && aiOk) {
      if (existingChat) { existingChat.messages.push({ role: 'user', content: message }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); await existingChat.save(); newThreadId = existingChat.threadId; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: message.substring(0, 50), messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; }
    }
    res.json({ reply, threadId: newThreadId, aiOk, provider });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/chat-with-file', async (req, res) => {
  try {
    const { prompt, fileBase64, mimeType, rollNo, name, threadId } = req.body;
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'fileBase64 and mimeType required.' });
    const userPrompt = prompt || 'Explain this file.';
    const cr = rollNo?.trim().toUpperCase() || 'guest';
    const userData = cr !== 'guest' ? await User.findOne({ rollNo: cr }) : null;
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || 'student';
    const systemPrompt = `You are "BM Bot". Helping ${userName} (${userRole}). Reply in SAME language. Markdown OK, no tables.`;
    let reply = '', aiOk = false;
    try { reply = await callGemini({ prompt: userPrompt, systemPrompt, fileBase64, mimeType, maxTokens: 3000, temperature: 0.4 }); aiOk = true; }
    catch (err) { reply = err.message; }
    let newThreadId = threadId;
    if (cr !== 'guest' && aiOk) {
      const existingChat = threadId ? await Chat.findOne({ threadId, rollNo: cr }) : null;
      if (existingChat) { existingChat.messages.push({ role: 'user', content: `[File] ${userPrompt}` }); existingChat.messages.push({ role: 'assistant', content: reply }); existingChat.updatedAt = new Date(); await existingChat.save(); newThreadId = existingChat.threadId; }
      else { const nt = await Chat.create({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: `File: ${userPrompt.substring(0, 40)}`, messages: [{ role: 'user', content: `[File] ${userPrompt}` }, { role: 'assistant', content: reply }] }); newThreadId = nt.threadId; }
    }
    res.json({ reply, threadId: newThreadId, aiOk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/generate-report-pdf', async (req, res) => {
  try {
    const { rollNo, reportType = 'student-attendance', targetRollNo } = req.body;
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
      const subRows = Object.entries(summary.subjectStats).map(([sub, st]) => [sub, `${st.present}/${st.total}`, `${st.percentage}%`]);
      pdfBuffer = await generatePDFBuffer({ title: `Student Attendance Report`, subtitle: `${targetUser.name} (${target})`, sections: [{ heading: 'Overview', bullets: [`Overall: ${summary.attendancePercentage}%`, `Attended: ${summary.totalAcademicLectures}/${summary.totalConductedLectures}`] }, { heading: 'Subject-wise', table: { headers: ['Subject', 'P/T', '%'], rows: subRows } }] });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${target}.pdf`);
      return res.send(pdfBuffer);
    }
    if (reportType === 'admin-defaulters') {
      const threshold = 75;
      const students = await User.find({ role: 'student' }).select('rollNo name branch');
      const defaulters = [];
      for (const s of students) {
        const summary = await getStudentSummary(s.rollNo);
        if (summary && summary.attendancePercentage < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: summary.attendancePercentage, present: summary.totalAcademicLectures, total: summary.totalConductedLectures });
      }
      defaulters.sort((a,b) => a.pct - b.pct);
      pdfBuffer = await generatePDFBuffer({ title: 'Defaulter Watchlist', subtitle: `Threshold: ${threshold}%`, sections: [{ heading: 'List', table: { headers: ['Roll', 'Name', 'Branch', 'P/T', '%'], rows: defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.pct}%`]) } }] });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=defaulters.pdf`);
      return res.send(pdfBuffer);
    }
    res.status(400).json({ error: 'Unknown reportType.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ADMIN REQUESTS SUMMARY ==========
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
      Rejected: await AttendanceRequest.countDocuments({ status: 'Rejected' })
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
    if (!r) return res.status(404).json({ error: 'Not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== FIX ALL ATTENDANCE ==========
app.post('/api/admin/fix-all-attendance-subjects', async (req, res) => {
  try {
    const { requesterRollNo, testRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    let students = testRollNo ? await User.find({ rollNo: testRollNo.toUpperCase(), role: 'student' }) : await User.find({ role: 'student' });
    const report = [];
    let totalStudents = 0, totalRenamed = 0, totalDeduplicated = 0;
    for (const s of students) {
      totalStudents++;
      const allRecords = await Attendance.find({ rollNo: s.rollNo });
      const seen = new Map();
      let renamed = 0, dedup = 0;
      for (const rec of allRecords) {
        const canon = mapToCanonical(rec.subject);
        if (canon !== rec.subject) { rec.subject = canon; await rec.save(); renamed++; }
        const key = `${rec.date}||${canon}`;
        if (seen.has(key)) { await Attendance.deleteOne({ _id: rec._id }); dedup++; }
        else seen.set(key, rec._id);
      }
      totalRenamed += renamed; totalDeduplicated += dedup;
      if (renamed || dedup) report.push({ rollNo: s.rollNo, name: s.name, renamed, dedup });
    }
    res.json({ message: 'Fix complete.', totalStudents, renamed: totalRenamed, deduplicated: totalDeduplicated, report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== Global Handlers ==========
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); process.exit(1); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT} | Groq(${GROQ_API_KEYS.length}) → Gemini(${GEMINI_API_KEYS.length}) | Tools: ${BOT_TOOLS.length}`));
