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

// ---------- Multi-key Gemini rotation ----------
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6
].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-flash-latest'];
const GEMINI_GLOBAL_TIMEOUT_MS = parseInt(process.env.GEMINI_GLOBAL_TIMEOUT_MS || '20000', 10);

let currentKeyIndex = 0;
function getNextApiKey() {
  if (GEMINI_API_KEYS.length === 0) return null;
  const key = GEMINI_API_KEYS[currentKeyIndex % GEMINI_API_KEYS.length];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
  return key;
}

// ---------- Env ----------
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 100;
const SEMESTER_START = new Date('2026-07-15T00:00:00+05:30');
const SEMESTER_END = new Date('2026-12-31T23:59:59+05:30');

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }
if (GEMINI_API_KEYS.length === 0) console.warn('⚠️ No GEMINI keys set');
else console.log(`🔑 Loaded ${GEMINI_API_KEYS.length} Gemini key(s)`);

// ---------- Helpers ----------
function getISTDateString(dateObj) {
  const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000));
  return istDate.toISOString().split('T')[0];
}

// ---------- Rate Limit ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: 'Too many requests.' } });
app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// ---------- Zod ----------
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

// ---------- TIMETABLES ----------
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

function getTimetableForBranch(branch) {
  if (branch && branch.toUpperCase() === 'AIDS') return AIDS_TIME_TABLE;
  return CSE_TIME_TABLE;
}

// ---------- Helper Functions ----------
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
  const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
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

// ---------- Schedules ----------
const CSE_SCHEDULE = {
  1: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2" },
    { start:"10:50", end:"11:35", subject:"DAA - Design & Analysis of Algorithm", period:"P3" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6" },
    { start:"13:50", end:"14:35", subject:"CN - Computer Network", period:"P7" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8" }
  ],
  2: [
    { start:"09:20", end:"10:05", subject:"WT - Web Technology", period:"P1" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2" },
    { start:"10:50", end:"11:35", subject:"Internet Lab (Ms. Geeta)", period:"P3" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6" },
    { start:"13:50", end:"14:35", subject:"BDA - Big Data Analytics", period:"P7" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8" }
  ],
  3: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3" },
    { start:"11:35", end:"12:20", subject:"Sports / Activity", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"13:50", subject:"WT - Web Technology", period:"P6" },
    { start:"13:50", end:"15:20", subject:"CN LAB - Computer Network Lab", period:"P7-P8" }
  ],
  4: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1" },
    { start:"10:05", end:"10:50", subject:"WT - Web Technology", period:"P2" },
    { start:"10:50", end:"11:35", subject:"CN - Computer Network", period:"P3" },
    { start:"11:35", end:"12:20", subject:"DAA - Design & Analysis of Algorithm", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"14:35", subject:"DAA LAB - Algorithm Lab", period:"P6-P7" },
    { start:"14:35", end:"15:20", subject:"HRM - Human Resource Mgmt", period:"P8" }
  ],
  5: [
    { start:"09:20", end:"10:05", subject:"DAA - Design & Analysis of Algorithm", period:"P1" },
    { start:"10:05", end:"10:50", subject:"CN - Computer Network", period:"P2" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3" },
    { start:"11:35", end:"12:20", subject:"BDA - Big Data Analytics", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"14:35", subject:"WT LAB - Web Technology Lab", period:"P6-P7" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8" }
  ]
};

const AIDS_SCHEDULE = {
  1: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2" },
    { start:"10:50", end:"11:35", subject:"LIB - Library", period:"P3" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6" },
    { start:"13:50", end:"14:35", subject:"PA - Predictive Analysis", period:"P7" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8" }
  ],
  2: [
    { start:"09:20", end:"10:05", subject:"WT - Web Technology", period:"P1" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2" },
    { start:"10:50", end:"11:35", subject:"PA - Predictive Analysis", period:"P3" },
    { start:"11:35", end:"12:20", subject:"FLA - Formal Language & Automata", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"13:50", subject:"HRM - Human Resource Mgmt", period:"P6" },
    { start:"13:50", end:"14:35", subject:"BDA - Big Data Analytics", period:"P7" },
    { start:"14:35", end:"15:20", subject:"ML - Machine Learning", period:"P8" }
  ],
  3: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1" },
    { start:"10:05", end:"10:50", subject:"ECO - Economics for Engineers", period:"P2" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3" },
    { start:"11:35", end:"12:20", subject:"Sports / Project", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"13:50", subject:"WT - Web Technology", period:"P6" },
    { start:"13:50", end:"15:20", subject:"PA LAB - Predictive Analysis Lab", period:"P7-P8" }
  ],
  4: [
    { start:"09:20", end:"10:05", subject:"BDA - Big Data Analytics", period:"P1" },
    { start:"10:05", end:"10:50", subject:"WT - Web Technology", period:"P2" },
    { start:"10:50", end:"11:35", subject:"ML - Machine Learning", period:"P3" },
    { start:"11:35", end:"12:20", subject:"PA - Predictive Analysis", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"14:35", subject:"ML LAB - Machine Learning Lab", period:"P6-P7" },
    { start:"14:35", end:"15:20", subject:"HRM - Human Resource Mgmt", period:"P8" }
  ],
  5: [
    { start:"09:20", end:"10:05", subject:"ML - Machine Learning", period:"P1" },
    { start:"10:05", end:"10:50", subject:"LIB - Library", period:"P2" },
    { start:"10:50", end:"11:35", subject:"FLA - Formal Language & Automata", period:"P3" },
    { start:"11:35", end:"12:20", subject:"BDA - Big Data Analytics", period:"P4" },
    { start:"12:20", end:"13:05", subject:"Lunch Break", period:"LUNCH" },
    { start:"13:05", end:"14:35", subject:"BDA LAB - Big Data Analytics Lab", period:"P6-P7" },
    { start:"14:35", end:"15:20", subject:"Sports", period:"P8" }
  ]
};

function getScheduleForBranch(branch) { return (branch && branch.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE; }

function getCurrentPeriod(branch = 'CSE') {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return null;
  const schedule = getScheduleForBranch(branch);
  const daySchedule = schedule[day] || [];
  const mins = now.getHours() * 60 + now.getMinutes();
  for (let slot of daySchedule) {
    const s = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);
    const e = parseInt(slot.end.split(':')[0]) * 60 + parseInt(slot.end.split(':')[1]);
    if (mins >= s && mins < e) return slot;
  }
  return null;
}

function getTimetableForDate(dateStr, branch = 'CSE') {
  const parts = dateStr.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[d.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return [];
  return getTimetableForBranch(branch)[dayName] || [];
}

// ---------- MongoDB ----------
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => { console.error('❌ MongoDB Error:', err.message); process.exit(1); });

// ---------- Schemas ----------
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
const passcodeSchema = new mongoose.Schema({ passcode: { type: String, required: true }, type: { type: String, enum: ['full_day', 'single_lecture'], required: true }, key: { type: String, unique: true, sparse: true }, expiresAt: { type: Date, required: true } }, { timestamps: true });
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

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const Passcode = mongoose.model('Passcode', passcodeSchema);
const TeacherSubject = mongoose.model('TeacherSubject', teacherSubjectSchema);
const Chat = mongoose.model('Chat', chatSchema);
const Leave = mongoose.model('Leave', leaveSchema);
Attendance.createIndexes().catch(err => console.error('Index error:', err));

// ---------- getStudentSummary ----------
async function getStudentSummary(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return null;
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
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
    allRecords.forEach(rec => {
      const sub = mapToCanonical(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        subPresent[sub] = (subPresent[sub] || 0) + 1;
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
    const daysPresent = allRecords.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
    const workingDaysSoFar = await getWorkingDays(semesterStart, today);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStart, SEMESTER_END);
    return { totalAcademicLectures: totalAttended, totalConductedLectures: totalConducted, attendancePercentage: pct, subjectStats: subjectStatsFinal, daysPresent, workingDaysSoFar, totalWorkingDaysSemester };
  } catch (e) { console.error('getStudentSummary error:', e); return null; }
}

// ============================================================
//  AI HELPER
// ============================================================
function parseGeminiError(err) {
  const msg = err.message || String(err);
  if (msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate')) {
    return { code: 429, type: 'RATE_LIMIT', friendly: '⏳ AI ka limit reach ho gaya. 30 sec baad try karo 🙏' };
  }
  if (msg.includes('503') || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('unavailable')) {
    return { code: 503, type: 'OVERLOADED', friendly: '⏳ AI server busy hai. 15 sec baad try karo 🙏' };
  }
  if (msg.includes('504') || msg.toLowerCase().includes('deadline') || msg.toLowerCase().includes('aborted')) {
    return { code: 504, type: 'TIMEOUT', friendly: '⏳ AI ne time liya zyada. Thodi der baad try karo.' };
  }
  if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
    return { code: 404, type: 'MODEL_NOT_FOUND', friendly: '⚠️ Model available nahi hai.' };
  }
  if (msg.includes('400') || msg.toLowerCase().includes('invalid')) {
    return { code: 400, type: 'BAD_REQUEST', friendly: '⚠️ Request invalid thi.' };
  }
  return { code: 500, type: 'UNKNOWN', friendly: '⚠️ AI error: ' + msg.substring(0, 100) };
}

async function callGeminiOnce({ prompt, systemPrompt = null, fileBase64 = null, mimeType = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 45000, model = null, apiKey = null }) {
  const useKey = apiKey || getNextApiKey();
  if (!useKey) throw new Error('No API key available');
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
  if (totalKeys === 0) throw new Error('No API key available');

  const perCallTimeout = args.globalTimeoutMs || GEMINI_GLOBAL_TIMEOUT_MS;
  const maxAttempts = args.maxAttempts || 6;

  const startTime = Date.now();
  let lastError = null;
  let attemptsMade = 0;
  let globalTimeoutHit = false;

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    const keysPerModel = Math.min(totalKeys, 3);
    let skipToNextModel = false;

    for (let attempt = 0; attempt < keysPerModel; attempt++) {
      if (Date.now() - startTime > perCallTimeout) {
        console.warn(`⏱️ Global timeout hit (${perCallTimeout}ms) — aborting chain`);
        globalTimeoutHit = true;
        break;
      }
      if (attemptsMade >= maxAttempts) {
        console.warn(`🛑 Max attempts (${maxAttempts}) reached — aborting`);
        break;
      }

      const apiKey = getNextApiKey();
      if (!apiKey) break;
      attemptsMade++;

      try {
        console.log(`🤖 ${model} (${attempt + 1}/${keysPerModel}) [total #${attemptsMade}] [timeout:${perCallTimeout}ms]`);
        return await callGeminiOnce({ ...args, model, apiKey });
      } catch (err) {
        lastError = err;
        const parsed = parseGeminiError(err);
        console.warn(`⚠️ ${model}: [${parsed.code} ${parsed.type}]`);

        if (parsed.type === 'RATE_LIMIT') {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        if (parsed.type === 'OVERLOADED' || parsed.type === 'TIMEOUT') {
          continue;
        }
        if (parsed.type === 'MODEL_NOT_FOUND' || parsed.type === 'BAD_REQUEST') {
          skipToNextModel = true;
          break;
        }
        continue;
      }
    }

    if (globalTimeoutHit) break;
    if (attemptsMade >= maxAttempts) break;
    if (skipToNextModel) continue;
  }

  const parsed = parseGeminiError(lastError);
  const friendly = globalTimeoutHit
    ? '⏳ AI ne zyada time liya. 30 second baad try karo 🙏'
    : parsed.friendly;
  const finalErr = new Error(friendly);
  finalErr.code = parsed.code;
  finalErr.type = parsed.type;
  throw finalErr;
}

// ---------- PDF Helper ----------
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
        if (sec.bullets && Array.isArray(sec.bullets)) {
          sec.bullets.forEach(b => doc.fillColor('#000').fontSize(11).font('Helvetica').text('•  ' + b, { indent: 10, lineGap: 3 }));
          doc.moveDown(0.6);
        }
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

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group ERP Active!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: GEMINI_API_KEYS.length > 0 ? 'gemini' : 'disabled',
  primaryModel: GEMINI_MODEL,
  fallbackModels: GEMINI_FALLBACK_MODELS,
  globalTimeoutMs: GEMINI_GLOBAL_TIMEOUT_MS,
  fileUploadTimeoutMs: 60000,
  keysLoaded: GEMINI_API_KEYS.length,
  pdf: 'enabled',
  imageSupport: 'enabled',
  fileTypes: ['application/pdf', 'text/plain', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  timestamp: new Date().toISOString()
}));
app.get('/api/ai/health', (req, res) => res.json({
  aiEnabled: GEMINI_API_KEYS.length > 0,
  primaryModel: GEMINI_MODEL,
  fallbackModels: GEMINI_FALLBACK_MODELS,
  globalTimeoutMs: GEMINI_GLOBAL_TIMEOUT_MS,
  fileUploadTimeoutMs: 60000,
  keysLoaded: GEMINI_API_KEYS.length,
  imageSupport: true,
  fileTypes: ['application/pdf', 'text/plain', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  features: ['chat', 'chat-with-file', 'chat-with-image', 'predict', 'admin-insights', 'generate-report-pdf', 'generate-notes-pdf', 'smart-alerts', 'subject-analysis']
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
    const doc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() } });
    if (doc) res.json({ valid: true });
    else res.status(400).json({ error: 'Invalid or expired.' });
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

// ========== FIX ALL ATTENDANCE ==========
app.post('/api/admin/fix-all-attendance-subjects', async (req, res) => {
  try {
    const { requesterRollNo, testRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo?.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }

    const todayStr = getISTDateString(new Date());
    const semesterStart = new Date('2026-07-15T00:00:00+05:30');

    let studentQuery = { role: 'student' };
    if (testRollNo && testRollNo.trim()) {
      studentQuery.rollNo = testRollNo.trim().toUpperCase();
    }
    const students = await User.find(studentQuery);
    if (!students.length) {
      return res.status(404).json({ error: testRollNo ? `Student ${testRollNo} not found!` : 'No students found' });
    }

    const allHolidays = await Holiday.find({});
    const holidaySet = new Set(allHolidays.map(h => h.date.split('T')[0]));

    let totalRemoved = 0, totalAdded = 0, totalRenamed = 0, totalDedup = 0;
    const report = [];

    for (const student of students) {
      const branch = student.branch || 'CSE';
      const timetable = getTimetableForBranch(branch);
      const allRecords = await Attendance.find({ rollNo: student.rollNo }).lean();
      if (!allRecords.length) {
        report.push({ rollNo: student.rollNo, name: student.name, branch, removed: 0, added: 0, renamed: 0, dedup: 0 });
        continue;
      }

      let sRemoved = 0, sAdded = 0, sRenamed = 0, sDedup = 0;
      const removedDetails = [], addedDetails = [];

      const grouped = {};
      for (const rec of allRecords) {
        const canon = mapToCanonical(rec.subject);
        if (!grouped[rec.date]) grouped[rec.date] = new Map();
        if (grouped[rec.date].has(canon)) {
          await Attendance.deleteOne({ _id: rec._id });
          sDedup++;
        } else {
          grouped[rec.date].set(canon, rec);
          if (rec.subject !== canon) {
            await Attendance.updateOne({ _id: rec._id }, { $set: { subject: canon } });
            sRenamed++;
          }
        }
      }

      let cur = new Date(semesterStart);
      const endDate = new Date(todayStr + 'T23:59:59Z');

      while (cur <= endDate) {
        const dateStr = getISTDateString(cur);
        const dow = cur.getDay();
        const isWeekend = (dow === 0 || dow === 6);
        const isHoliday = holidaySet.has(dateStr);

        if (!isWeekend && !isHoliday) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
          const ttSubjects = [...new Set(
            (timetable[dayName] || [])
              .map(s => mapToCanonical(s.subject))
              .filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'))
          )];

          const studentSubjects = grouped[dateStr] || new Map();

          for (const [sub, rec] of studentSubjects) {
            if (!ttSubjects.includes(sub)) {
              await Attendance.deleteOne({ _id: rec._id });
              studentSubjects.delete(sub);
              sRemoved++;
              removedDetails.push(`${dateStr}: ${sub}`);
            }
          }

          const presentCount = ttSubjects.filter(s => studentSubjects.has(s)).length;
          const totalCount = ttSubjects.length;

          if (totalCount > 0 && presentCount >= Math.ceil(totalCount / 2) && presentCount < totalCount) {
            const missing = ttSubjects.filter(s => !studentSubjects.has(s));
            for (const missSub of missing) {
              try {
                await new Attendance({
                  rollNo: student.rollNo,
                  studentName: student.name,
                  subject: missSub,
                  date: dateStr,
                  status: 'Present',
                  location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
                  ipAddress: 'fix-all-auto',
                  isVerified: true,
                  branch: branch
                }).save();
                sAdded++;
                addedDetails.push(`${dateStr}: ${missSub}`);
              } catch (e) {
                if (e.code !== 11000) throw e;
              }
            }
          }
        }
        cur.setDate(cur.getDate() + 1);
      }

      totalRemoved += sRemoved;
      totalAdded += sAdded;
      totalRenamed += sRenamed;
      totalDedup += sDedup;

      report.push({
        rollNo: student.rollNo,
        name: student.name,
        branch,
        removed: sRemoved,
        added: sAdded,
        renamed: sRenamed,
        dedup: sDedup,
        removedDetails: removedDetails.slice(0, 30),
        addedDetails: addedDetails.slice(0, 30)
      });
    }

    console.log(`🛠️ Fix-all: removed=${totalRemoved}, added=${totalAdded}, renamed=${totalRenamed}, dedup=${totalDedup}`);
    res.json({
      message: `✅ Scanned ${students.length} students. Removed ${totalRemoved} extras, added ${totalAdded} missing, renamed ${totalRenamed}, dedup ${totalDedup}.`,
      totalStudents: students.length,
      removed: totalRemoved,
      added: totalAdded,
      renamed: totalRenamed,
      deduplicated: totalDedup,
      testMode: !!testRollNo,
      report
    });
  } catch (err) {
    console.error('Fix all attendance error:', err);
    res.status(500).json({ error: err.message });
  }
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

// ============================================================
//  ✅ PASSCODE — with force flag support
// ============================================================
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type, force } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'User not found!' });
    if (req1.role === 'admin') { /* ok */ }
    else if (req1.role === 'faculty' && type === 'single_lecture') { /* ok */ }
    else return res.status(403).json({ error: 'Access Denied.' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

    // ✅ Block on weekend/holiday
    const todayStr = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayStr);
    if (dateStatus.isBlocked) {
      return res.status(400).json({
        error: dateStatus.type === 'WEEKEND'
          ? `📅 ${dateStatus.dayName}: College closed. Passcode not needed.`
          : `🎉 ${dateStatus.holiday || 'Holiday'}: College closed. Passcode not needed.`,
        blocked: true,
        type: dateStatus.type
      });
    }

    if (type === 'single_lecture') {
      const branch = req1.branch || 'CSE';
      const period = getCurrentPeriod(branch);
      if (!period) return res.status(400).json({ error: 'No active lecture.' });
      const now = new Date();
      const ds = getISTDateString(now);
      const key = `single_lecture_${ds}_${period.start}`;

      // ✅ If force = true, delete existing and generate new
      if (force) {
        await Passcode.deleteMany({ key, type: 'single_lecture' });
      } else {
        // Return existing if valid
        let doc = await Passcode.findOne({ key, type: 'single_lecture' });
        if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing', passcode: doc.passcode, type, expiresAt: doc.expiresAt });
      }

      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const expiry = new Date(now.getTime() + 5 * 60 * 1000);
      await new Passcode({ passcode, type, key, expiresAt: expiry }).save();
      await Passcode.deleteMany({ type: 'single_lecture', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : 'Generated', passcode, type, expiresAt: expiry, changed: !!force });
    }

    if (type === 'full_day') {
      const now = new Date();
      const ds = getISTDateString(now);
      const key = `full_day_${ds}`;

      if (force) {
        await Passcode.deleteMany({ key, type: 'full_day' });
      } else {
        let doc = await Passcode.findOne({ key, type: 'full_day' });
        if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing', passcode: doc.passcode, type, expiresAt: doc.expiresAt });
      }

      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiry = new Date(now); expiry.setHours(23, 59, 59, 999);
      await new Passcode({ passcode, type, key, expiresAt: expiry }).save();
      await Passcode.deleteMany({ type: 'full_day', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : 'Generated', passcode, type, expiresAt: expiry, changed: !!force });
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
    if (doc) return res.json({ passcode: doc.passcode, expiresAt: doc.expiresAt });
    return res.json({ passcode: null, message: 'No passcode' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE MARKING ==========
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
    const doc = await Passcode.findOne({ key, type: 'single_lecture', passcode, expiresAt: { $gt: new Date() } });
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
    const doc = await Passcode.findOne({ passcode: passcode.trim(), type: 'full_day', expiresAt: { $gt: new Date() } });
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
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const todayDate = getISTDateString(new Date());
    const ds = await checkDateStatus(todayDate);
    if (ds.isBlocked) return res.status(400).json({ error: ds.message });
    const cr = rollNo.trim().toUpperCase();
    const bc = await checkStudentBlocked(cr);
    if (bc.blocked) return res.status(403).json({ error: bc.message });
    const lc = checkLocation(latitude, longitude);
    if (!lc.isInside) { await incrementFailedAttempts(cr); return res.status(400).json({ error: `Outside (${lc.distance}m)` }); }
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const subj = mapToCanonical(subject);
    const isLab = subj.includes("LAB") || subj.includes("Lab");
    const today = await Attendance.find({ rollNo: cr, subject: subj, date: todayDate });
    if (isLab && today.length >= 1) return res.status(400).json({ error: `Already marked (lab).` });
    user.failedAttempts = 0; user.blockUntil = null;
    await new Attendance({ rollNo: cr, studentName: name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: user.branch || 'CSE' }).save();
    user.lastAttendanceTime = new Date(); user.lastAttendanceLocation = { latitude, longitude };
    await user.save();
    res.status(201).json({ message: `✅ Marked for ${subject}!` });
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
    res.json({ totalStudents, todayPresent, todayAbsent: absent.length, overallAttendance: totalAtt, overallPct, todayPresentStudents: presentList, workingDaysSoFar, totalWorkingDaysSemester });
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
    const holidaySet = new Set((await Holiday.find({ date: { $gte: startStr, $lte: endStr } })).map(h => h.date.split('T')[0]));

    const todayStr = getISTDateString(new Date());

    let cur = new Date(startD);
    while (cur <= endD) {
      const ds = getISTDateString(cur);
      if (ds > todayStr) { cur.setDate(cur.getDate() + 1); continue; }
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
        const dayName = dayNameMap[dow];
        (tt[dayName] || []).forEach(e => {
          const sub = mapToCanonical(e.subject);
          if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) { subSet.add(sub); totalConducted++; }
        });
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
    records.forEach(rec => {
      const sub = mapToCanonical(rec.subject);
      if (stats[sub] && (rec.status === 'Present' || rec.status === 'Duty Leave')) stats[sub].present++;
    });
    let totalAttended = 0;
    Object.values(stats).forEach(st => totalAttended += st.present);
    const pct = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : 0;
    const presentDays = new Set(records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').map(r => r.date));
    const sWithPct = {};
    Object.keys(stats).forEach(sub => {
      const st = stats[sub];
      sWithPct[sub] = { total: st.total, present: st.present, percentage: st.total > 0 ? Math.round((st.present / st.total) * 100) : 0 };
    });
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
    const branch = user.branch || 'CSE';
    const tt = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo: cr }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
    const today = new Date();
    const todayStr = getISTDateString(today);
    const semesterStart = new Date('2026-07-15T00:00:00+05:30');
    let cur = new Date(semesterStart);
    let totalConducted = 0;
    const acadDays = new Set();
    const stats = {};
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayAcad = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subs = tt[dayName] || [];
      const acad = subs.filter(e => !e.subject.includes("LIB") && !e.subject.includes("Library") && !e.subject.includes("Sports"));
      dayAcad[dayName] = acad.map(e => mapToCanonical(e.subject));
    }
    while (cur <= today) {
      const ds = getISTDateString(cur);
      if (ds > todayStr) { cur.setDate(cur.getDate() + 1); continue; }
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
        acadDays.add(ds);
        const dayName = dayNameMap[dow];
        const acad = dayAcad[dayName] || [];
        totalConducted += acad.length;
        acad.forEach(sub => { if (!stats[sub]) stats[sub] = { total: 0, present: 0 }; stats[sub].total++; });
      }
      cur.setDate(cur.getDate() + 1);
    }
    const presentDaysSet = new Set();
    const subPresent = {};
    allRecords.forEach(rec => {
      const sub = mapToCanonical(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        subPresent[sub] = (subPresent[sub] || 0) + 1;
        presentDaysSet.add(rec.date);
      }
    });
    Object.keys(subPresent).forEach(sub => { if (stats[sub]) stats[sub].present = subPresent[sub]; });
    let totalAttended = 0;
    Object.values(subPresent).forEach(v => totalAttended += v);
    const pct = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : 0;
    const daysPresent = presentDaysSet.size;
    const totalWorkingDays = acadDays.size;
    const sFinal = {};
    for (let [sub, st] of Object.entries(stats)) {
      sFinal[sub] = { present: st.present || 0, total: st.total || 0, percentage: st.total > 0 ? Math.round(((st.present || 0) / st.total) * 100) : 0 };
    }
    const workingDaysSoFar = await getWorkingDays(semesterStart, today);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStart, SEMESTER_END);
    res.json({ totalAcademicLectures: totalAttended, totalConductedLectures: totalConducted, attendancePercentage: pct, daysPresent, daysAbsent: totalWorkingDays - daysPresent, workingDaysSoFar, totalWorkingDaysSemester, subjectStats: sFinal });
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
    // ✅ Clamp end date to today
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

// ========== SUBJECTS ==========
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
    const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
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
          (tt[dayNameMap[dow]] || []).forEach(e => {
            const sub = mapToCanonical(e.subject);
            if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) totalCond++;
          });
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

// ========== BULK CSE ==========
app.post('/api/admin/bulk-register-and-update-attendance', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.body.requesterRollNo?.trim().toUpperCase() || '' });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const data = [
      { rollNo: '24CSE01', name: 'AAKASH RAJ CHAUHAN', present: 35 },{ rollNo: '24CSE03', name: 'ABHISHEK VERMA', present: 0 },
      { rollNo: '24CSE04', name: 'ANKIT KUMAR', present: 0 },{ rollNo: '24CSE06', name: 'ANSHIKA', present: 44 },
      { rollNo: '24CSE08', name: 'ANUJ TIWARI', present: 0 },{ rollNo: '24CSE09', name: 'ASHISH KUMAR', present: 47 },
      { rollNo: '24CSE11', name: 'B DEVIKA', present: 0 },{ rollNo: '24CSE14', name: 'GAUTAM', present: 35 },
      { rollNo: '24CSE15', name: 'HARSH RAJ', present: 11 },{ rollNo: '24CSE16', name: 'HIMANSHI', present: 38 },
      { rollNo: '24CSE18', name: 'HITESH YADAV', present: 0 },{ rollNo: '24CSE19', name: 'ISHANT KUMAR', present: 44 },
      { rollNo: '24CSE20', name: 'JATIN', present: 0 },{ rollNo: '24CSE21', name: 'JATIN YADAV', present: 0 },
      { rollNo: '24CSE22', name: 'JITIN YADAV', present: 0 },{ rollNo: '24CSE23', name: 'KAUSHAL KUMAR', present: 18 },
      { rollNo: '24CSE24', name: 'KRISH BHARDWAJ', present: 1 },{ rollNo: '24CSE25', name: 'MANISH', present: 0 },
      { rollNo: '24CSE27', name: 'MANMOHAN KUMAR', present: 0 },{ rollNo: '24CSE28', name: 'MANOJ', present: 5 },
      { rollNo: '24CSE29', name: 'MAYANK', present: 0 },{ rollNo: '24CSE30', name: 'MD SAMIR ALAM', present: 0 },
      { rollNo: '24CSE31', name: 'MUDIT BEDI', present: 8 },{ rollNo: '24CSE33', name: 'NEHA SHUKLA', present: 39 },
      { rollNo: '24CSE35', name: 'PRASHANT', present: 0 },{ rollNo: '24CSE36', name: 'PREETI', present: 39 },
      { rollNo: '24CSE37', name: 'PURAV RAO', present: 1 },{ rollNo: '24CSE38', name: 'RACHIT SINGH', present: 0 },
      { rollNo: '24CSE39', name: 'RAHUL', present: 0 },{ rollNo: '24CSE40', name: 'RISHAV RAJ', present: 0 },
      { rollNo: '24CSE41', name: 'RITU KUMARI', present: 18 },{ rollNo: '24CSE42', name: 'ROHIT SHRESTA', present: 43 },
      { rollNo: '24CSE43', name: 'RUPESH KUMAR', present: 0 },{ rollNo: '24CSE44', name: 'SAHIL', present: 0 },
      { rollNo: '24CSE45', name: 'SAIESH', present: 0 },{ rollNo: '24CSE46', name: 'SAKSHI KUMARI', present: 21 },
      { rollNo: '24CSE47', name: 'SOURABH RAJPUT', present: 0 },{ rollNo: '24CSE48', name: 'SUMIT SHARMA', present: 12 },
      { rollNo: '24CSE49', name: 'TUSHAR KUMAR', present: 44 },{ rollNo: '24CSE51', name: 'VIDHI BHARGAV', present: 22 },
      { rollNo: '24CSE52', name: 'VINAY', present: 32 }
    ];
    const sD = new Date('2026-07-15T00:00:00+05:30');
    const eD = new Date('2026-07-30T23:59:59+05:30');
    const sStr = getISTDateString(sD), eStr = getISTDateString(eD);
    let reg = 0, added = 0;
    for (const item of data) {
      let user = await User.findOne({ rollNo: item.rollNo });
      if (user) { user.name = item.name; user.branch = 'CSE'; user.password = await bcrypt.hash('123456', 10); await user.save(); }
      else {
        const nu = new User({ name: item.name, rollNo: item.rollNo, password: await bcrypt.hash('123456', 10), role: 'student', branch: 'CSE', boundDeviceId: null });
        await nu.save(); user = nu; reg++;
      }
      await Attendance.deleteMany({ rollNo: item.rollNo, date: { $gte: sStr, $lte: eStr } });
      if (item.present === 0) continue;
      let days = [];
      let cur = new Date(sD);
      while (cur <= eD) {
        const ds = getISTDateString(cur);
        const dow = cur.getDay();
        const isHol = await Holiday.findOne({ date: ds });
        if (dow !== 0 && dow !== 6 && !isHol) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
          const tt = getTimetableForBranch('CSE');
          const acad = (tt[dayName] || []).map(s => mapToCanonical(s.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          days.push({ date: ds, subjects: acad });
        }
        cur.setDate(cur.getDate() + 1);
      }
      let all = [];
      for (const d of days) for (const sub of d.subjects) all.push({ date: d.date, subject: sub });
      const toMark = Math.min(item.present, all.length);
      for (let i = 0; i < toMark; i++) {
        const e = all[i];
        await new Attendance({ rollNo: item.rollNo, studentName: item.name, subject: e.subject, date: e.date, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'bulk-update', isVerified: true, branch: 'CSE' }).save();
        added++;
      }
    }
    res.json({ message: 'CSE bulk done!', totalRegistered: reg, totalAttendanceAdded: added });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== BULK AIDS ==========
app.post('/api/admin/bulk-register-and-update-attendance-aids', async (req, res) => {
  try {
    const req1 = await User.findOne({ rollNo: req.body.requesterRollNo?.trim().toUpperCase() || '' });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const data = [
      { rollNo: '24AIDS01', name: 'AKASH', present: 1 },{ rollNo: '24AIDS03', name: 'DAVANSH SINGH KARKI', present: 5 },
      { rollNo: '24AIDS04', name: 'FAIZAN AHMAD', present: 40 },{ rollNo: '24AIDS05', name: 'GOPESH JHA', present: 0 },
      { rollNo: '24AIDS06', name: 'HEMANT YADAV', present: 0 },{ rollNo: '24AIDS07', name: 'HUSNAIN AHMAD', present: 40 },
      { rollNo: '24AIDS08', name: 'JANHVI', present: 0 },{ rollNo: '24AIDS09', name: 'JYOTI PUSHPA ROUT', present: 26 },
      { rollNo: '24AIDS11', name: 'MAHIMA', present: 38 },{ rollNo: '24AIDS12', name: 'MOHAMMAD HAMID KHALIL', present: 0 },
      { rollNo: '24AIDS13', name: 'PIYUSH KUMAR', present: 0 },{ rollNo: '24AIDS14', name: 'PRINCE KUMAR', present: 0 },
      { rollNo: '24AIDS16', name: 'SACHIN', present: 0 },{ rollNo: '24AIDS17', name: 'SAHIL PRASAD', present: 5 },
      { rollNo: '24AIDS19', name: 'VINAY', present: 38 }
    ];
    const sD = new Date('2026-07-15T00:00:00+05:30');
    const eD = new Date('2026-07-30T23:59:59+05:30');
    const sStr = getISTDateString(sD), eStr = getISTDateString(eD);
    let reg = 0, added = 0;
    for (const item of data) {
      let user = await User.findOne({ rollNo: item.rollNo });
      if (user) { user.name = item.name; user.branch = 'AIDS'; user.password = await bcrypt.hash('123456', 10); await user.save(); }
      else {
        const nu = new User({ name: item.name, rollNo: item.rollNo, password: await bcrypt.hash('123456', 10), role: 'student', branch: 'AIDS', boundDeviceId: null });
        await nu.save(); user = nu; reg++;
      }
      await Attendance.deleteMany({ rollNo: item.rollNo, date: { $gte: sStr, $lte: eStr } });
      if (item.present === 0) continue;
      let days = [];
      let cur = new Date(sD);
      while (cur <= eD) {
        const ds = getISTDateString(cur);
        const dow = cur.getDay();
        const isHol = await Holiday.findOne({ date: ds });
        if (dow !== 0 && dow !== 6 && !isHol) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
          const tt = getTimetableForBranch('AIDS');
          const acad = (tt[dayName] || []).map(s => mapToCanonical(s.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          days.push({ date: ds, subjects: acad });
        }
        cur.setDate(cur.getDate() + 1);
      }
      let all = [];
      for (const d of days) for (const sub of d.subjects) all.push({ date: d.date, subject: sub });
      const toMark = Math.min(item.present, all.length);
      for (let i = 0; i < toMark; i++) {
        const e = all[i];
        await new Attendance({ rollNo: item.rollNo, studentName: item.name, subject: e.subject, date: e.date, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'bulk-update', isVerified: true, branch: 'AIDS' }).save();
        added++;
      }
    }
    res.json({ message: 'AIDS bulk done!', totalRegistered: reg, totalAttendanceAdded: added });
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
    const leave = new Leave({ rollNo: cr, studentName: user.name, fromDate, toDate, reason, leaveType: leaveType || 'Personal', branch: user.branch || 'CSE' });
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

// ========== TREND ==========
app.get('/api/student/trend/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    const months = [6,7,8,9,10,11];
    const labels = ['Jul','Aug','Sep','Oct','Nov','Dec'];
    const data = [];
    for (const m of months) {
      const start = new Date(2026, m, 1);
      const end = new Date(2026, m + 1, 0);
      const sStr = getISTDateString(start), eStr = getISTDateString(end);
      const recs = await Attendance.find({ rollNo: cr, date: { $gte: sStr, $lte: eStr } });
      const present = recs.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
      data.push({ month: labels[m-6], present, total: recs.length });
    }
    res.json(data);
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
//  AI: Chat
// ============================================================
function buildRoleSystemPrompt({ role, userName, contextStr, greeting, emoji }) {
  const base = greeting ? `${greeting}, ${userName} ${emoji}!` : '';
  if (role === 'admin') {
    return `You are "BM Bot Admin Assistant" for BM Group ERP.
${base}
Assisting ADMIN.
Context:
${contextStr}
Role:
- Provide admin-level insights (stats, defaulters, class trends).
- Suggest admin actions.
- Draft notices & warnings professionally.
- Be professional, data-driven.
- Respond in user's language (Hindi/English).
- NEVER use markdown tables. Use bullet points for comparison.`;
  }
  if (role === 'faculty') {
    return `You are "BM Bot Faculty Assistant" for BM Group.
${base}
Assisting FACULTY.
Context:
${contextStr}
Role:
- Help with assigned subjects, students, class averages.
- Suggest teaching material.
- Be supportive, concise.
- Respond in user's language (Hindi/English).
- NEVER use markdown tables. Use bullet points.`;
  }
  return `You are "BM Bot" for BM Group of Institutions attendance portal.
${base}
Assisting STUDENT.
Context:
${contextStr}
Role:
- Answer questions on attendance, timetable, holidays.
- If user asks "kitne bunk kar sakta hun" — calculate using 75% rule.
- If asked for notes — provide with headings, bullets, examples.
- Warn politely if attendance below 75%.
- Be friendly, encouraging, use emojis.
- Respond in user's language (Hindi/English).
- NEVER use markdown tables. Use bullet points for any comparison.`;
}

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId, skipGreeting } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const cr = rollNo?.trim().toUpperCase() || 'guest';

    let userData = null, attendanceSummary = null, workingDays = 0, holidays = [], currentPeriod = null;
    let existingChat = null;
    if (cr !== 'guest' && threadId) {
      try { existingChat = await Chat.findOne({ threadId, rollNo: cr }); }
      catch (e) { console.warn('Chat history fetch failed:', e.message); }
    }

    if (cr !== 'guest') {
      try {
        userData = await User.findOne({ rollNo: cr });
        if (userData) {
          attendanceSummary = await getStudentSummary(userData.rollNo);
          const today = new Date();
          const startStr = getISTDateString(SEMESTER_START);
          const todayStr = getISTDateString(today);
          workingDays = await getWorkingDays(SEMESTER_START, today);
          holidays = await Holiday.find({ date: { $gte: startStr, $lte: todayStr } });
          currentPeriod = getCurrentPeriod(userData.branch || 'CSE');
        }
      } catch (err) { console.error('Error fetching user data:', err); }
    }

    let requestedDate = null, requestedDay = null;
    const mLow = message.toLowerCase();
    if (mLow.includes('kal') || mLow.includes('tomorrow')) {
      const d = new Date(); d.setDate(d.getDate() + 1); requestedDate = getISTDateString(d);
    } else if (mLow.includes('aaj') || mLow.includes('today')) {
      requestedDate = getISTDateString(new Date());
    } else {
      const dm = message.match(/(\d{1,2})\s+([A-Za-z]+)/) || message.match(/([A-Za-z]+)\s+(\d{1,2})/);
      if (dm) {
        const dayNum = parseInt(dm[1] || dm[2]);
        const monthName = dm[2] || dm[1];
        const mMap = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
        const mIdx = mMap[monthName.toLowerCase()];
        if (mIdx !== undefined && dayNum >= 1 && dayNum <= 31) {
          const d = new Date(2026, mIdx, dayNum);
          if (!isNaN(d)) requestedDate = getISTDateString(d);
        }
      }
      const dayNames = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      for (const dn of dayNames) { if (mLow.includes(dn)) { requestedDay = dn.charAt(0).toUpperCase() + dn.slice(1); break; } }
    }

    let requestedTimetable = null, requestedStatus = null;
    if (requestedDate) {
      const status = await checkDateStatus(requestedDate);
      requestedStatus = status;
      if (!status.isBlocked) requestedTimetable = getTimetableForDate(requestedDate, userData?.branch || branch || 'CSE');
    } else if (requestedDay) {
      requestedTimetable = getTimetableForBranch(userData?.branch || branch || 'CSE')[requestedDay] || [];
    }

    const now = new Date();
    const hour = now.getHours();
    let greeting = '', emoji = '';
    if (!skipGreeting) {
      if (hour < 12) { greeting = 'Good morning'; emoji = '🌞'; }
      else if (hour < 17) { greeting = 'Good afternoon'; emoji = '🌤️'; }
      else { greeting = 'Good evening'; emoji = '🌙'; }
    }
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';

    let contextStr = `Date/time: ${now.toLocaleString()}\n`;
    contextStr += `User: ${userName} (Roll: ${cr}, Role: ${userRole})\n`;
    contextStr += `Branch: ${userData?.branch || branch || 'CSE'}\n`;
    if (attendanceSummary) contextStr += `Attendance: ${JSON.stringify(attendanceSummary, null, 2)}\n`;
    contextStr += `Working days so far: ${workingDays}\n`;
    if (holidays.length) contextStr += `Holidays: ${holidays.map(h => `${h.date} (${h.reason})`).join(', ')}\n`;
    const todayDay = now.toLocaleString('en', { weekday: 'long' });
    const todayTT = getTimetableForBranch(userData?.branch || branch || 'CSE')[todayDay] || [];
    contextStr += `Today (${todayDay}): ${todayTT.map(s => s.subject).join(', ')}\n`;
    if (currentPeriod) contextStr += `Current period: ${currentPeriod.subject} (${currentPeriod.start}-${currentPeriod.end})\n`;
    else contextStr += `Current period: none\n`;
    if (requestedDate) {
      if (requestedStatus && requestedStatus.isBlocked) contextStr += `Requested date ${requestedDate} is blocked: ${requestedStatus.message}\n`;
      else if (requestedTimetable && requestedTimetable.length) contextStr += `Timetable ${requestedDate}: ${requestedTimetable.map(s => s.subject).join(', ')}\n`;
      else contextStr += `No timetable for ${requestedDate}.\n`;
    } else if (requestedDay) {
      if (requestedTimetable && requestedTimetable.length) contextStr += `Timetable ${requestedDay}: ${requestedTimetable.map(s => s.subject).join(', ')}\n`;
      else contextStr += `No timetable for ${requestedDay}.\n`;
    }

    const systemPrompt = buildRoleSystemPrompt({ role: userRole, userName, contextStr, greeting, emoji });

    let reply = '';
    let aiOk = false;
    try {
      reply = await callGemini({
        prompt: message,
        systemPrompt,
        history: existingChat?.messages,
        maxTokens: 1500,
        temperature: 0.7,
        timeoutMs: 20000
      });
      aiOk = true;
    } catch (err) {
      console.warn('⚠️ AI failed:', err.message, '| type:', err.type);
      reply = err.message;
    }

    let newThreadId = threadId, newTitle = 'New Chat';
    if (cr !== 'guest' && aiOk) {
      if (existingChat) {
        existingChat.messages.push({ role: 'user', content: message });
        existingChat.messages.push({ role: 'assistant', content: reply });
        existingChat.updatedAt = new Date();
        if (!existingChat.title || existingChat.title === 'New Chat') existingChat.title = message.substring(0, 50);
        await existingChat.save();
        newThreadId = existingChat.threadId; newTitle = existingChat.title;
      } else {
        const autoTitle = message.substring(0, 50) || 'New Chat';
        const nt = new Chat({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: autoTitle, messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply }] });
        await nt.save();
        newThreadId = nt.threadId; newTitle = autoTitle;
      }
    } else if (cr !== 'guest' && !aiOk) {
      newThreadId = threadId || null;
    }

    res.json({ reply, threadId: newThreadId, title: newTitle, aiOk });
  } catch (err) {
    console.error('❌ Chat error:', err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

// ============================================================
//  AI: Chat with FILE / IMAGE
// ============================================================
app.post('/api/ai/chat-with-file', async (req, res) => {
  try {
    const { prompt, fileBase64, mimeType, rollNo, role, name, branch, threadId } = req.body;
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'fileBase64 and mimeType required.' });
    const userPrompt = prompt || 'Explain this document/file. Give me a clear summary with key points.';

    const allowed = [
      'application/pdf',
      'text/plain',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif'
    ];
    const isAllowed = allowed.some(t => mimeType === t || mimeType.includes(t));
    if (!isAllowed) {
      return res.status(400).json({ error: `Unsupported file type: ${mimeType}. Allowed: PDF, TXT, JPEG, PNG, WEBP, GIF.` });
    }

    const cr = rollNo?.trim().toUpperCase() || 'guest';
    let userData = null, attendanceSummary = null;
    if (cr !== 'guest') {
      userData = await User.findOne({ rollNo: cr });
      if (userData) attendanceSummary = await getStudentSummary(userData.rollNo);
    }
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';

    let contextStr = `User: ${userName} (Roll: ${cr}, Role: ${userRole})\n`;
    contextStr += `Branch: ${userData?.branch || branch || 'CSE'}\n`;
    if (attendanceSummary) contextStr += `Attendance: ${attendanceSummary.attendancePercentage}% (${attendanceSummary.totalAcademicLectures}/${attendanceSummary.totalConductedLectures})\n`;

    const fileLabels = {
      pdf: 'PDF document',
      plain: 'text file',
      jpeg: 'image (JPEG)',
      jpg: 'image (JPEG)',
      png: 'image (PNG)',
      webp: 'image (WebP)',
      gif: 'image (GIF)'
    };
    const subtype = mimeType.split('/')[1];
    const fileTypeLabel = fileLabels[subtype] || 'file';

    const systemPrompt = `You are "BM Bot" for BM Group.
Helping ${userName} (${userRole}) with a ${fileTypeLabel}.
Context:
${contextStr}
Task:
- Carefully read/analyze the uploaded ${fileTypeLabel}.
- If image — describe contents, extract text if any, answer user's question about it.
- If PDF/text — extract, summarize, explain.
- If code file — explain the code, fix bugs, improve.
- If notes — provide structured summary with headings and bullets.
- Use markdown formatting: headings, bullets, bold.
- NEVER use markdown tables. Use bullet points instead.
- Respond in user's language (Hindi/English).`;

    let reply = '';
    let aiOk = false;
    try {
      reply = await callGemini({
        prompt: userPrompt,
        systemPrompt,
        fileBase64,
        mimeType,
        maxTokens: 3000,
        temperature: 0.4,
        timeoutMs: 60000,
        globalTimeoutMs: 60000,
        maxAttempts: 2
      });
      aiOk = true;
    } catch (err) {
      console.warn('⚠️ File/Image AI failed:', err.message, '| type:', err.type);
      reply = err.message;
    }

    let newThreadId = threadId, newTitle = 'File Analysis';
    if (cr !== 'guest' && aiOk) {
      const existingChat = threadId ? await Chat.findOne({ threadId, rollNo: cr }) : null;
      if (existingChat) {
        existingChat.messages.push({ role: 'user', content: `[Uploaded ${fileTypeLabel}] ${userPrompt}` });
        existingChat.messages.push({ role: 'assistant', content: reply });
        existingChat.updatedAt = new Date();
        await existingChat.save();
        newThreadId = existingChat.threadId; newTitle = existingChat.title;
      } else {
        const autoTitle = `File: ${userPrompt.substring(0, 40)}`;
        const nt = new Chat({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: autoTitle, messages: [{ role: 'user', content: `[Uploaded ${fileTypeLabel}] ${userPrompt}` }, { role: 'assistant', content: reply }] });
        await nt.save();
        newThreadId = nt.threadId; newTitle = autoTitle;
      }
    }

    res.json({ reply, threadId: newThreadId, title: newTitle, fileType: fileTypeLabel, aiOk });
  } catch (err) {
    console.error('❌ chat-with-file error:', err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

// ============================================================
//  AI: Generate PDF Report
// ============================================================
app.post('/api/ai/generate-report-pdf', async (req, res) => {
  try {
    const { rollNo, reportType = 'student-attendance', targetRollNo, startDate, endDate, branch } = req.body;
    const cr = rollNo?.trim().toUpperCase();
    if (!cr) return res.status(400).json({ error: 'rollNo required' });
    const requester = await User.findOne({ rollNo: cr });
    if (!requester) return res.status(404).json({ error: 'User not found' });
    if (reportType === 'admin-defaulters' && requester.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    if (reportType === 'class-report' && requester.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

    let pdfBuffer;
    if (reportType === 'student-attendance') {
      const target = targetRollNo ? targetRollNo.trim().toUpperCase() : cr;
      if (requester.role === 'student' && target !== cr) return res.status(403).json({ error: 'Can only export own report.' });
      const targetUser = await User.findOne({ rollNo: target });
      if (!targetUser) return res.status(404).json({ error: 'Target not found' });
      const summary = await getStudentSummary(target);
      if (!summary) return res.status(500).json({ error: 'Could not generate summary' });
      const rStart = startDate || getISTDateString(SEMESTER_START);
      let rEnd = endDate || getISTDateString(new Date());
      const todayStr = getISTDateString(new Date());
      if (rEnd > todayStr) rEnd = todayStr;
      const records = await Attendance.find({ rollNo: target, date: { $gte: rStart, $lte: rEnd } }).sort({ date: 1 }).lean();
      const subRows = Object.entries(summary.subjectStats).map(([sub, st]) => [sub, `${st.present}/${st.total}`, `${st.percentage}%`]);
      const sections = [
        { heading: '📊 Overview', bullets: [
          `Overall Attendance: ${summary.attendancePercentage}%`,
          `Lectures Attended: ${summary.totalAcademicLectures} / ${summary.totalConductedLectures}`,
          `Days Present: ${summary.daysPresent}`,
          `Working Days So Far: ${summary.workingDaysSoFar} / ${summary.totalWorkingDaysSemester}`,
          `Status: ${summary.attendancePercentage >= 75 ? '✅ Safe' : '⚠️ Below 75%'}`
        ]},
        { heading: '📚 Subject-wise', table: { headers: ['Subject', 'Present/Total', 'Percentage'], rows: subRows } },
        { heading: '📅 Recent 30 Records', table: { headers: ['Date', 'Subject', 'Status'], rows: records.slice(-30).reverse().map(r => [r.date, mapToCanonical(r.subject), r.status]) } }
      ];
      pdfBuffer = await generatePDFBuffer({ title: 'Student Attendance Report', subtitle: `${targetUser.name} (${target}) • ${targetUser.branch || 'CSE'} • ${rStart} to ${rEnd} (up to today)`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${target}_${rStart}.pdf`);
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
        { heading: `⚠️ Defaulters Below ${threshold}%`, text: `Total: ${defaulters.length} out of ${students.length}` },
        { heading: '📋 List', table: { headers: ['Roll No', 'Name', 'Branch', 'Present/Total', '%'], rows: defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.pct}%`]) } }
      ];
      pdfBuffer = await generatePDFBuffer({ title: 'Defaulter Watchlist', subtitle: `Threshold: ${threshold}% • Branch: ${branch || 'ALL'}`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=defaulters_${threshold}pct.pdf`);
      return res.send(pdfBuffer);
    }

    if (reportType === 'class-report') {
      const start = startDate ? new Date(startDate) : new Date(SEMESTER_START);
      let end = endDate ? new Date(endDate) : new Date(SEMESTER_END);
      const today = new Date();
      if (end > today) end = today;
      const startStr = getISTDateString(start), endStr = getISTDateString(end);
      let q = { role: 'student' };
      if (branch && branch !== 'ALL' && branch !== 'undefined') q.branch = branch.toUpperCase();
      const students = await User.find(q).select('rollNo name branch');
      const holidays = await Holiday.find({ date: { $gte: startStr, $lte: endStr } });
      const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
      const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const rows = [];
      let sumPct = 0;
      for (const s of students) {
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
        const pc = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: endStr }, status: { $in: ['Present', 'Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
        const pct = totalCond > 0 ? Math.round((pc / totalCond) * 100) : 0;
        sumPct += pct;
        rows.push([s.rollNo, s.name, b, `${pc}/${totalCond}`, `${pct}%`]);
      }
      rows.sort((a,b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
      const avg = rows.length > 0 ? Math.round(sumPct / rows.length) : 0;
      const sections = [
        { heading: '📊 Summary', bullets: [`Branch: ${branch || 'ALL'}`, `Period: ${startStr} to ${endStr}`, `Total Students: ${rows.length}`, `Average: ${avg}%`] },
        { heading: '📋 Student-wise', table: { headers: ['Roll No', 'Name', 'Branch', 'Present/Total', '%'], rows } }
      ];
      pdfBuffer = await generatePDFBuffer({ title: 'Class Attendance Report', subtitle: `Branch: ${branch || 'ALL'} • ${startStr} to ${endStr}`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=class_report_${branch || 'ALL'}_${startStr}.pdf`);
      return res.send(pdfBuffer);
    }
    res.status(400).json({ error: 'Unknown reportType.' });
  } catch (err) { console.error('❌ PDF report error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Notes PDF
// ============================================================
app.post('/api/ai/generate-notes-pdf', async (req, res) => {
  try {
    const { topic, subject, rollNo, level = 'B.Tech 5th Semester', includeMCQ = false } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const cr = rollNo?.trim().toUpperCase();
    let userName = 'Student';
    if (cr) { const u = await User.findOne({ rollNo: cr }); if (u) userName = u.name; }
    if (GEMINI_API_KEYS.length === 0) return res.status(503).json({ error: 'AI not configured.' });

    const prompt = `Generate comprehensive study notes on "${topic}"${subject ? ` (Subject: ${subject})` : ''} for ${level}.
Requirements:
- Start with short Intro (2-3 lines)
- Main content with clear sub-headings and bullet points
- Include key definitions, important concepts, formulas (if any)
- Include 2-3 real-world examples
${includeMCQ ? '- Include 5 MCQs with 4 options each and mark correct answer' : ''}
- End with "Quick Revision" of 5-6 bullets
Format: plain text, use ## for headings, • for bullets. NO ** asterisks. NO markdown tables.`;

    let notesText;
    try {
      notesText = await callGemini({
        prompt,
        systemPrompt: 'You are an expert teacher creating structured study notes. Use ## for headings, • for bullets. Avoid asterisks. Avoid tables.',
        maxTokens: 3500,
        temperature: 0.5,
        timeoutMs: 45000,
        globalTimeoutMs: 45000,
        maxAttempts: 2
      });
    } catch (err) {
      console.warn('⚠️ Notes AI failed:', err.message);
      return res.status(503).json({ error: err.message });
    }

    const lines = notesText.split('\n');
    const sections = [];
    let current = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('## ') || t.startsWith('# ')) {
        if (current) sections.push(current);
        current = { heading: t.replace(/^#+\s*/, ''), bullets: [] };
      } else if (t.startsWith('• ') || t.startsWith('- ') || t.startsWith('* ')) {
        if (!current) current = { heading: 'Notes', bullets: [] };
        current.bullets.push(t.replace(/^[•\-*]\s*/, ''));
      } else if (/^\d+\.\s/.test(t)) {
        if (!current) current = { heading: 'Notes', bullets: [] };
        current.bullets.push(t);
      } else {
        if (!current) current = { heading: 'Introduction', text: t };
        else if (current.bullets && current.bullets.length === 0 && !current.text) current.text = t;
        else { if (!current.bullets) current.bullets = []; current.bullets.push(t); }
      }
    }
    if (current) sections.push(current);

    const pdfBuffer = await generatePDFBuffer({
      title: 'Study Notes',
      subtitle: `${topic}${subject ? ` • ${subject}` : ''} • For ${userName}`,
      sections,
      footer: `Generated by BM Bot • ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=notes_${topic.replace(/\s+/g, '_').substring(0, 30)}.pdf`);
    res.send(pdfBuffer);
  } catch (err) { console.error('❌ Notes PDF error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Predict Attendance
// ============================================================
app.post('/api/ai/predict-attendance', async (req, res) => {
  try {
    const { rollNo, targetPercentage = 75, plannedBunks = 0, plannedAttends = 0 } = req.body;
    const cr = rollNo?.trim().toUpperCase();
    if (!cr) return res.status(400).json({ error: 'rollNo required' });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const summary = await getStudentSummary(cr);
    if (!summary) return res.status(500).json({ error: 'Could not compute' });
    const attended = summary.totalAcademicLectures;
    const conducted = summary.totalConductedLectures;
    const currentPct = summary.attendancePercentage;
    const target = parseFloat(targetPercentage);
    const maxBunks = Math.floor((attended * 100 / target) - conducted);
    const requiredAttends = currentPct >= target ? 0 : Math.ceil(((target / 100) * conducted - attended) / (1 - target / 100));
    let simPct = currentPct;
    let sA = attended, sC = conducted;
    if (plannedAttends > 0) { sA += plannedAttends; sC += plannedAttends; }
    if (plannedBunks > 0) sC += plannedBunks;
    simPct = sC > 0 ? Math.round((sA / sC) * 100) : 0;

    let aiMessage = '';
    if (GEMINI_API_KEYS.length > 0) {
      try {
        aiMessage = await callGemini({
          prompt: `Student ${user.name} (${cr}) has ${currentPct}% attendance (${attended}/${conducted}). Min required: ${target}%. Give short encouraging Hinglish response (2-3 lines): current situation, max ${maxBunks} bunks OR ${requiredAttends} attends needed, motivational tip. No asterisks.`,
          systemPrompt: 'You are BM Bot, friendly student assistant at BM Group. Respond in Hinglish, short.',
          maxTokens: 300,
          temperature: 0.7,
          timeoutMs: 15000,
          globalTimeoutMs: 10000,
          maxAttempts: 2
        });
      } catch (err) { console.warn('Predict AI msg failed:', err.message); }
    }
    if (!aiMessage) {
      aiMessage = currentPct >= target
        ? `Bhai, tu safe hai! Abhi tu ${maxBunks} lectures bunk kar sakta hai ${target}% pe rehne ke liye. 💪`
        : `Bhai, tu ${target}% se neeche hai. Next ${requiredAttends} lectures consecutively attend kar. 📚`;
    }
    res.json({ currentPercentage: currentPct, attended, conducted, targetPercentage: target, maxBunksAllowed: maxBunks > 0 ? maxBunks : 0, requiredConsecutiveAttends: requiredAttends, simulated: { plannedAttends, plannedBunks, resultingPercentage: simPct }, aiMessage });
  } catch (err) { console.error('❌ Predict error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Admin Insights
// ============================================================
app.post('/api/ai/admin-insights', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo?.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const totalStudents = await User.countDocuments({ role: 'student' });
    const totalFaculty = await User.countDocuments({ role: 'faculty' });
    const totalAttendance = await Attendance.countDocuments();
    const totalPresent = await Attendance.countDocuments({ status: 'Present' });
    const overallPct = totalAttendance > 0 ? Math.round((totalPresent / totalAttendance) * 100) : 0;
    const today = getISTDateString(new Date());
    const todayPresent = await Attendance.distinct('rollNo', { date: today, status: 'Present' });
    const students = await User.find({ role: 'student' }).select('rollNo name branch');
    const startStr = getISTDateString(SEMESTER_START);
    const defaulters = [];
    for (const s of students) {
      const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const pct = total > 0 ? Math.round((present/total)*100) : 0;
      if (pct < 75) defaulters.push({ rollNo: s.rollNo, name: s.name, pct, present, total });
    }
    defaulters.sort((a,b) => a.pct - b.pct);
    const subAgg = await Attendance.aggregate([
      { $match: { subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } } },
      { $group: { _id: '$subject', total: { $sum: 1 }, present: { $sum: { $cond: [{ $in: ['$status', ['Present', 'Duty Leave']] }, 1, 0] } } } },
      { $sort: { present: 1 } }
    ]);
    const contextStr = `Dashboard:\n- Total students: ${totalStudents}\n- Total faculty: ${totalFaculty}\n- Total records: ${totalAttendance}\n- Overall %: ${overallPct}%\n- Today present: ${todayPresent.length}\n- Defaulters (<75%): ${defaulters.length}\n- Top 10 defaulters: ${defaulters.slice(0, 10).map(d => `${d.rollNo}(${d.name}): ${d.pct}%`).join(', ')}\n- Subject-wise (lowest 5): ${subAgg.slice(0, 5).map(s => `${mapToCanonical(s._id)}: ${Math.round((s.present/s.total)*100)}%`).join(', ')}`;

    let insights = '';
    if (GEMINI_API_KEYS.length > 0) {
      try {
        insights = await callGemini({
          prompt: `Analyze this admin dashboard data. Structure:\n1. Overview (2 lines)\n2. Key Concerns (top 3)\n3. Recommended Actions (3-4 bullets)\n4. Positive Highlights\nUse ## for headings, • for bullets. No ** asterisks. No tables.\n\n${contextStr}`,
          systemPrompt: 'You are BM Bot Admin Assistant. Provide data-driven insights. Concise, actionable.',
          maxTokens: 1200,
          temperature: 0.5,
          timeoutMs: 45000,
          globalTimeoutMs: 45000,
          maxAttempts: 2
        });
      } catch (err) { console.warn('AI insights failed:', err.message); insights = '⚠️ ' + err.message; }
    }
    if (!insights) {
      insights = `## Overview\nTotal ${totalStudents} students, ${overallPct}% overall. ${defaulters.length} defaulters.\n\n## Key Concerns\n• ${defaulters.length} below 75%\n• Today: ${todayPresent.length}/${totalStudents} present\n\n## Recommended Actions\n• Send warnings\n• Review subjects`;
    }
    res.json({ stats: { totalStudents, totalFaculty, totalAttendance, overallPct, todayPresentCount: todayPresent.length, defaulterCount: defaulters.length }, topDefaulters: defaulters.slice(0, 10), subjectAggregate: subAgg.map(s => ({ subject: mapToCanonical(s._id), total: s.total, present: s.present, pct: Math.round((s.present/s.total)*100) })), insights });
  } catch (err) { console.error('❌ Admin insights error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Subject Analysis
// ============================================================
app.post('/api/ai/subject-analysis', async (req, res) => {
  try {
    const { rollNo } = req.body;
    const cr = rollNo?.trim().toUpperCase();
    if (!cr) return res.status(400).json({ error: 'rollNo required' });
    const user = await User.findOne({ rollNo: cr });
    if (!user) return res.status(404).json({ error: 'Not found!' });
    const summary = await getStudentSummary(cr);
    if (!summary) return res.status(500).json({ error: 'Could not compute' });
    const subjects = Object.entries(summary.subjectStats || {}).map(([sub, st]) => ({ subject: sub, ...st }));
    subjects.sort((a, b) => a.percentage - b.percentage);
    const weak = subjects.filter(s => s.percentage < 75);
    const strong = subjects.filter(s => s.percentage >= 75);

    let aiAnalysis = '';
    if (GEMINI_API_KEYS.length > 0 && subjects.length > 0) {
      try {
        aiAnalysis = await callGemini({
          prompt: `Student ${user.name} (${cr}) attendance:\n${subjects.map(s => `• ${s.subject}: ${s.present}/${s.total} (${s.percentage}%)`).join('\n')}\n\nProvide:\n1. Weak subjects (<75%) with specific advice\n2. Strong subjects — positive reinforcement\n3. Overall strategy (2-3 bullets)\nUse ## headings, • bullets. No tables. Hinglish, encouraging.`,
          systemPrompt: 'You are BM Bot, friendly student mentor. Personalized advice in Hinglish.',
          maxTokens: 1000,
          temperature: 0.6,
          timeoutMs: 45000,
          globalTimeoutMs: 45000,
          maxAttempts: 2
        });
      } catch (err) { console.warn('Subject analysis AI failed:', err.message); }
    }
    if (!aiAnalysis) {
      aiAnalysis = `## Overall\nAttendance: ${summary.attendancePercentage}%\n\n## Weak (<75%)\n${weak.length > 0 ? weak.map(s => `• ${s.subject}: ${s.percentage}%`).join('\n') : '• None!'}\n\n## Strong (>=75%)\n${strong.map(s => `• ${s.subject}: ${s.percentage}%`).join('\n')}`;
    }
    res.json({ overall: summary.attendancePercentage, subjects, weakSubjects: weak, strongSubjects: strong, analysis: aiAnalysis });
  } catch (err) { console.error('❌ Subject analysis error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Smart Alerts
// ============================================================
app.post('/api/ai/smart-alerts', async (req, res) => {
  try {
    const { requesterRollNo, threshold = 75, limit = 20 } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo?.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const students = await User.find({ role: 'student' }).select('rollNo name branch');
    const today = getISTDateString(new Date());
    const startStr = getISTDateString(SEMESTER_START);
    const defaulters = [];
    for (const s of students) {
      const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const pct = total > 0 ? Math.round((present/total)*100) : 0;
      if (pct < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
    }
    defaulters.sort((a,b) => a.pct - b.pct);
    const top = defaulters.slice(0, limit);
    const alerts = [];
    for (const d of top) {
      let message = '';
      if (GEMINI_API_KEYS.length > 0) {
        try {
          message = await callGemini({
            prompt: `Write short polite warning (2-3 lines, Hinglish) for parent/student:\nStudent: ${d.name} (${d.rollNo}, ${d.branch})\nAttendance: ${d.pct}% (${d.present}/${d.total})\nRequired: ${threshold}%\nNo asterisks.`,
            systemPrompt: 'You are BM Bot writing official warning notices for BM Group.',
            maxTokens: 200,
            temperature: 0.6,
            timeoutMs: 15000,
            globalTimeoutMs: 10000,
            maxAttempts: 2
          });
        } catch (err) { message = ''; }
      }
      if (!message) message = `Dear ${d.name}, your attendance is ${d.pct}% which is below the required ${threshold}%. Please attend classes regularly. - BM Group`;
      alerts.push({ ...d, message });
    }
    res.json({ threshold, totalDefaulters: defaulters.length, alertsSent: alerts.length, alerts });
  } catch (err) { console.error('❌ Smart alerts error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Study Material
// ============================================================
app.post('/api/ai/study-material', async (req, res) => {
  try {
    const { topic, subject, type = 'notes' } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    if (GEMINI_API_KEYS.length === 0) return res.status(503).json({ error: 'AI not configured.' });
    const typeMap = { notes: 'detailed study notes with headings and bullets', mcq: '10 MCQs with 4 options each', summary: 'concise summary', important: 'important topics for exam', examples: 'real-world examples' };
    const styleGuide = typeMap[type] || typeMap.notes;
    let reply;
    try {
      reply = await callGemini({
        prompt: `Generate ${styleGuide} on: "${topic}"${subject ? ` (Subject: ${subject})` : ''}.\nUse ## for headings, • for bullets. No tables.`,
        systemPrompt: 'Expert teacher for B.Tech students at BM Group.',
        maxTokens: 2500,
        temperature: 0.5,
        timeoutMs: 45000,
        globalTimeoutMs: 45000,
        maxAttempts: 2
      });
    } catch (err) { return res.status(503).json({ error: err.message }); }
    res.json({ topic, subject, type, content: reply });
  } catch (err) { console.error('❌ Study material error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  RESTORE FROM CSV
// ============================================================
app.post('/api/admin/restore-from-csv', async (req, res) => {
  try {
    const { requesterRollNo, csvData } = req.body;
    if (!requesterRollNo || !csvData) return res.status(400).json({ error: 'requesterRollNo and csvData required' });
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || req1.role !== 'admin') return res.status(403).json({ error: 'Admin only!' });
    const rows = [];
    const stream = Readable.from(csvData);
    await new Promise((resolve, reject) => { stream.pipe(csv()).on('data', r => rows.push(r)).on('end', resolve).on('error', reject); });
    if (!rows.length) return res.status(400).json({ error: 'No data' });
    let headers = null;
    for (const row of rows) { const k = Object.keys(row); if (k.some(x => /roll/i.test(x) && /no/i.test(x)) || k.some(x => /date/i.test(x))) { headers = k; break; } }
    if (!headers) headers = Object.keys(rows[0]);
    const rIdx = headers.findIndex(h => /roll/i.test(h) && /no/i.test(h));
    const nIdx = headers.findIndex(h => /name/i.test(h) || /student/i.test(h));
    const sIdx = headers.findIndex(h => /subject/i.test(h));
    const dIdx = headers.findIndex(h => /date/i.test(h));
    const stIdx = headers.findIndex(h => /status/i.test(h));
    if (rIdx === -1 || dIdx === -1 || sIdx === -1) return res.status(400).json({ error: 'CSV must have Roll No, Date, Subject columns' });
    const dataRows = [];
    for (const row of rows) {
      const roll = row[headers[rIdx]]?.trim(), date = row[headers[dIdx]]?.trim(), subject = row[headers[sIdx]]?.trim();
      const status = row[headers[stIdx]]?.trim() || 'Present';
      const name = nIdx !== -1 ? row[headers[nIdx]]?.trim() : '';
      if (!roll || !date || !subject) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (subject.toLowerCase().includes('total') || subject.toLowerCase().includes('student')) continue;
      dataRows.push({ roll, date, subject, status, name });
    }
    if (!dataRows.length) return res.status(400).json({ error: 'No valid records' });
    await Attendance.deleteMany({});
    const toInsert = dataRows.map(r => ({
      rollNo: r.roll, studentName: r.name || 'Unknown',
      subject: mapToCanonical(r.subject), date: r.date,
      status: r.status === 'Duty Leave' ? 'Duty Leave' : 'Present',
      location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
      ipAddress: 'restore-from-csv', isVerified: true,
      branch: /AIDS/i.test(r.roll) ? 'AIDS' : 'CSE'
    }));
    const chunkSize = 500;
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      await Attendance.insertMany(chunk, { ordered: false });
      inserted += chunk.length;
    }
    res.json({ message: `Restored ${inserted} records.`, totalRecords: inserted, studentsAffected: [...new Set(toInsert.map(r => r.rollNo))].length });
  } catch (err) { console.error('Restore error:', err); res.status(500).json({ error: err.message }); }
});

// ---------- Global Handlers ----------
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); process.exit(1); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT} | AI: ${GEMINI_API_KEYS.length} keys | Model: ${GEMINI_MODEL} | Chat timeout: ${GEMINI_GLOBAL_TIMEOUT_MS}ms | File/Image timeout: 40000ms | PDF: enabled | Images: enabled`));
