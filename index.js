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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
const GEMINI_GLOBAL_TIMEOUT_MS = parseInt(process.env.GEMINI_GLOBAL_TIMEOUT_MS || '20000', 10);

let currentKeyIndex = 0;
function getNextApiKey() {
  if (GEMINI_API_KEYS.length === 0) return null;
  const key = GEMINI_API_KEYS[currentKeyIndex % GEMINI_API_KEYS.length];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
  return key;
}

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

function getISTDateString(dateObj) {
  const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000));
  return istDate.toISOString().split('T')[0];
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

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => { console.error('❌ MongoDB Error:', err.message); process.exit(1); });

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

// Passcode extended with publish support
const passcodeSchema = new mongoose.Schema({
  passcode: { type: String, required: true },
  type: { type: String, enum: ['full_day', 'single_lecture'], required: true },
  key: { type: String, unique: true, sparse: true },
  expiresAt: { type: Date, required: true },
  published: { type: Boolean, default: false },           // 👈 NEW: publicly visible to students
  publishedAt: { type: Date, default: null },
  publishedBy: { type: String, default: null },
  durationMinutes: { type: Number, default: null }         // 👈 FIXED duration publish
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

// 👇 NEW: Student attendance correction requests
const attendanceRequestSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  branch: { type: String, default: 'CSE' },
  dates: [{ type: String }],                                // YYYY-MM-DD list
  subjects: [{ type: String }],                             // optional specific subjects
  reason: { type: String, required: true },
  requestType: { type: String, enum: ['Attendance Correction', 'Leave', 'Other'], default: 'Attendance Correction' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null },
  adminNote: { type: String, default: '' },
  reviewedDates: [{ type: String }],                        // date-by-date review
  rejectedDates: [{ type: String }]
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

Attendance.createIndexes().catch(err => console.error('Index error:', err));

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
  const maxAttempts = args.maxAttempts || 12;

  const startTime = Date.now();
  let lastError = null;
  let attemptsMade = 0;
  let globalTimeoutHit = false;

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    const keysPerModel = Math.min(totalKeys, 6);
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
        if (parsed.type === 'OVERLOADED' || parsed.type === 'TIMEOUT') continue;
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
    ? 'AI took too long to respond. Please try again in about 30 seconds.'
    : parsed.friendly;
  const finalErr = new Error(friendly);
  finalErr.code = parsed.code;
  finalErr.type = parsed.type;
  throw finalErr;
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

// ============================================================
//  SMART CONTEXT — Detect intent for optional context inclusion
// ============================================================
function detectContextNeeds(msg) {
  const m = (msg || '').toLowerCase();
  return {
    attendance: /attendance|present|absent|bunk|percentage|hazri|upasthiti|kitni|kitne|75|skip/i.test(m),
    timetable: /timetable|schedule|class|period|lecture|kab hai|kya hai class|today'?s|kal|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(m),
    holiday: /holiday|chutti|closed|band hai|avkash|tyohar/i.test(m),
    currentPeriod: /current|abhi|now|chalu|active|right now/i.test(m),
    passcode: /passcode|password|otp|code/i.test(m),
    requests: /request|leave|correction|approval/i.test(m)
  };
}

// ============================================================
//  DATABASE ASSISTANT — Intent Detection Prompt
// ============================================================
const DB_OPERATION_PROMPT = `You are a Database Assistant for BM Group ERP (attendance portal). Your job: convert user's natural language request into a JSON database operation OR a general reply.

## User Context (will be injected):
- Role: student/faculty/admin
- RollNo, Name, Branch

## Available Collections (MongoDB):
1. **users** — { rollNo, name, role, branch, email, phone, semester }
2. **attendances** — { rollNo, studentName, subject, date (YYYY-MM-DD), status (Present/Absent/Duty Leave), branch }
3. **holidays** — { date (YYYY-MM-DD), reason }
4. **notices** — { title, message, date }
5. **leaves** — { rollNo, studentName, fromDate, toDate, reason, leaveType, status }
6. **passcodes** — { passcode, type (full_day/single_lecture), expiresAt, published }
7. **teachersubjects** — { teacherRollNo, subject, assignedBy }
8. **attendancerequests** — { rollNo, studentName, dates[], subjects[], reason, status }

## Response format (STRICT JSON only, NO markdown, NO code fence):
{
  "action": "reply" | "db_read" | "db_count" | "db_aggregate" | "db_create" | "db_update" | "db_delete" | "db_publish_passcode" | "db_create_request" | "db_review_request",
  "collection": "users" | "attendances" | "holidays" | "notices" | "leaves" | "passcodes" | "teachersubjects" | "attendancerequests" | null,
  "filter": { ...MongoDB filter... } | null,
  "update": { ...fields... } | null,
  "data": { ...new doc... } | null,
  "limit": number | null,
  "sort": { "field": 1|-1 } | null,
  "explanation": "Short Hinglish explanation (1-2 lines)",
  "requiresConfirmation": true|false,
  "reply": "If action is 'reply', the AI's natural language response here (Hinglish/English mix). Otherwise null."
}

## Rules:
1. If user's message is just chat/greeting/notes/study-help → action "reply", put answer in "reply"
2. If user asks to see/check data → db_read (no confirmation)
3. If user asks to add/create something → db_create
4. If user asks to modify/update → db_update (confirm: true)
5. If user asks to delete/remove → db_delete (confirm: true)
6. If user asks to count/find how many → db_count (no confirmation)
7. If user asks "how many days can I bunk" or attendance % → db_aggregate (no confirmation)
8. If user asks to publish passcode for a duration → db_publish_passcode (admin only)
9. If student asks to send attendance correction request → db_create_request
10. If admin/faculty wants to approve/reject request → db_review_request
11. NEVER let students modify attendances/users/holidays/passcodes directly
12. Date format strictly YYYY-MM-DD
13. "meri/my/apni" → use user's own rollNo
14. Role restrictions enforced separately — you just structure the operation
15. Return ONLY valid JSON, no explanation outside JSON

## Examples:
User: "Meri attendance kitni hai?"  Role: student
→ { "action": "db_aggregate", "collection": "attendances", "filter": { "rollNo": "{USER_ROLL}" }, "explanation": "Aapki attendance calculate kar raha hun", "requiresConfirmation": false, "reply": null }

User: "Kitne students 75% se neeche hai?"  Role: admin
→ { "action": "db_aggregate", "collection": "attendances", "explanation": "Defaulters count kar raha hun", "requiresConfirmation": false, "reply": null }

User: "Diwali holiday add karo 25 Oct 2026"  Role: admin
→ { "action": "db_create", "collection": "holidays", "data": { "date": "2026-10-25", "reason": "Diwali" }, "explanation": "Diwali holiday add kar raha hun", "requiresConfirmation": false, "reply": null }

User: "Notice post karo: Exam kal hai"  Role: admin
→ { "action": "db_create", "collection": "notices", "data": { "title": "Announcement", "message": "Exam kal hai" }, "explanation": "Notice publish kar raha hun", "requiresConfirmation": false, "reply": null }

User: "24CSE48 ki attendance 30 records delete karo"  Role: admin
→ { "action": "db_delete", "collection": "attendances", "filter": { "rollNo": "24CSE48" }, "limit": 30, "explanation": "24CSE48 ki 30 attendance records delete karunga", "requiresConfirmation": true, "reply": null }

User: "Passcode publish karo next 30 minutes ke liye single lecture"  Role: admin
→ { "action": "db_publish_passcode", "data": { "type": "single_lecture", "durationMinutes": 30 }, "explanation": "Passcode 30 min ke liye publish kar raha hun", "requiresConfirmation": false, "reply": null }

User: "Main 12 Oct aur 13 Oct present tha, request bhej do"  Role: student
→ { "action": "db_create_request", "collection": "attendancerequests", "data": { "dates": ["2026-10-12", "2026-10-13"], "reason": "Attendance correction", "requestType": "Attendance Correction" }, "explanation": "Attendance correction request bhej raha hun", "requiresConfirmation": true, "reply": null }

User: "Pending requests dikhao"  Role: admin
→ { "action": "db_read", "collection": "attendancerequests", "filter": { "status": "Pending" }, "explanation": "Pending requests fetch kar raha hun", "requiresConfirmation": false, "reply": null }

User: "Request 12345 approve kar do"  Role: admin
→ { "action": "db_review_request", "data": { "requestId": "12345", "action": "Approved" }, "explanation": "Request approve kar raha hun", "requiresConfirmation": false, "reply": null }

User: "Hello"
→ { "action": "reply", "reply": "Hello! Kaise help kar sakta hun?", "explanation": "Greeting", "requiresConfirmation": false, "collection": null }

User: "BDA notes do"
→ { "action": "reply", "reply": "## BDA - Big Data Analytics\\n\\n...", "explanation": "Notes de raha hun", "requiresConfirmation": false, "collection": null }
`;

async function detectIntent(message, userContext) {
  const ctx = `Role: ${userContext.role}\nRollNo: ${userContext.rollNo}\nName: ${userContext.name}\nBranch: ${userContext.branch}\nToday: ${getISTDateString(new Date())}`;
  const prompt = `${ctx}\n\nUser message: "${message}"\n\nReturn ONLY valid JSON.`;
  try {
    const reply = await callGemini({
      prompt,
      systemPrompt: DB_OPERATION_PROMPT,
      maxTokens: 1500,
      temperature: 0.3,
      timeoutMs: 12000,
      globalTimeoutMs: 30000,
      maxAttempts: 4
    });
    let cleaned = reply.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('Intent detection failed:', err.message);
    return { action: 'reply', reply: null, explanation: 'Could not parse', requiresConfirmation: false };
  }
}

// ============================================================
//  ROLE-BASED DB OPERATION EXECUTOR
// ============================================================
async function executeDbAction(intent, userContext) {
  const { action, collection, filter, update, data, limit, sort } = intent;
  const isAdmin = userContext.role === 'admin';
  const isFaculty = userContext.role === 'faculty';
  const isStudent = userContext.role === 'student';

  const collMap = {
    users: User, attendances: Attendance, holidays: Holiday,
    notices: Notice, leaves: Leave, passcodes: Passcode,
    teachersubjects: TeacherSubject, attendancerequests: AttendanceRequest
  };

  // ---- Permission Gates ----
  // Students: read-only on own data, plus can create attendance requests
  if (isStudent) {
    if (['db_create', 'db_update', 'db_delete'].includes(action)) {
      if (collection !== 'attendancerequests') {
        return { error: 'Students can only read their own data or submit attendance requests. Direct DB modification is not allowed.' };
      }
    }
    if (['db_read', 'db_count', 'db_aggregate'].includes(action)) {
      // Force own rollNo
      if (collection === 'attendances' || collection === 'leaves' || collection === 'attendancerequests') {
        filter = filter || {};
        filter.rollNo = userContext.rollNo;
      }
      if (collection === 'users') {
        filter = filter || {};
        filter.rollNo = userContext.rollNo;
      }
      // Students can't read passcodes/notices via db (they use public endpoint)
      if (collection === 'passcodes') return { error: 'Passcodes are accessed via a separate public endpoint.' };
    }
  }

  // Faculty: read assigned students; can modify attendance only for assigned subjects; can review requests
  if (isFaculty) {
    if (['users', 'notices', 'holidays', 'passcodes'].includes(collection) && action !== 'db_read' && action !== 'db_count') {
      return { error: 'Faculty cannot modify this collection.' };
    }
    if (collection === 'attendances' && ['db_create', 'db_update', 'db_delete'].includes(action)) {
      const assigned = await TeacherSubject.find({ teacherRollNo: userContext.rollNo }).distinct('subject');
      if (filter && filter.subject && !assigned.includes(filter.subject)) return { error: 'Only your assigned subjects.' };
      if (update && update.subject && !assigned.includes(update.subject)) return { error: 'Only your assigned subjects.' };
      if (data && data.subject && !assigned.includes(data.subject)) return { error: 'Only your assigned subjects.' };
    }
    if (collection === 'attendancerequests' && action === 'db_review_request') {
      // allowed
    }
    if (collection === 'attendancerequests' && action !== 'db_read' && action !== 'db_review_request' && action !== 'db_count') {
      return { error: 'Faculty can only read/review requests.' };
    }
  }

  try {
    const Model = collMap[collection];

    // ---- READ ----
    if (action === 'db_read') {
      if (!Model) return { error: 'Unknown collection' };
      let q = Model.find(filter || {});
      if (sort) q = q.sort(sort);
      q = q.limit(Math.min(limit || 20, 100));
      const docs = await q.lean();
      const sanitized = docs.map(d => {
        if (!isAdmin) { delete d.password; delete d.activeSession; delete d.boundDeviceId; }
        return d;
      });
      return { result: sanitized, count: sanitized.length };
    }

    // ---- COUNT ----
    if (action === 'db_count') {
      if (!Model) return { error: 'Unknown collection' };
      const count = await Model.countDocuments(filter || {});
      return { result: { count } };
    }

    // ---- AGGREGATE (attendance % specifically) ----
    if (action === 'db_aggregate') {
      if (collection === 'attendances') {
        if (isAdmin && (!filter || !filter.rollNo)) {
          // Admin-wide defaulters count
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
          return { result: { totalDefaulters: defaulters.length, defaulters: defaulters.slice(0, 20) } };
        }
        const rollNo = (filter && filter.rollNo) || userContext.rollNo;
        const summary = await getStudentSummary(rollNo);
        if (!summary) return { error: 'Student not found' };
        return { result: { rollNo, attendancePercentage: summary.attendancePercentage, attended: summary.totalAcademicLectures, conducted: summary.totalConductedLectures, subjectStats: summary.subjectStats, workingDaysSoFar: summary.workingDaysSoFar, totalWorkingDaysSemester: summary.totalWorkingDaysSemester } };
      }
      return { error: 'Aggregate only supported for attendances' };
    }

    // ---- CREATE ----
    if (action === 'db_create') {
      if (!Model) return { error: 'Unknown collection' };
      if (collection === 'holidays') {
        if (!isAdmin) return { error: 'Only admin can add holidays' };
        if (!data || !data.date) return { error: 'Holiday date missing' };
        await Holiday.findOneAndUpdate({ date: data.date }, { date: data.date, reason: data.reason || 'Holiday' }, { upsert: true });
        return { result: { date: data.date, reason: data.reason } };
      }
      if (collection === 'notices') {
        if (!isAdmin) return { error: 'Only admin can post notices' };
        const n = await new Notice({ title: data.title || 'Announcement', message: data.message, date: new Date() }).save();
        return { result: n.toObject() };
      }
      if (collection === 'attendances') {
        if (!data || !data.rollNo || !data.subject || !data.date) return { error: 'Missing attendance fields' };
        const stu = await User.findOne({ rollNo: data.rollNo });
        if (!stu) return { error: 'Student not found' };
        try {
          const rec = await new Attendance({
            rollNo: data.rollNo, studentName: stu.name, subject: mapToCanonical(data.subject),
            date: data.date, status: data.status || 'Present',
            location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
            ipAddress: 'chatbot-create', isVerified: true, branch: stu.branch || 'CSE'
          }).save();
          return { result: rec.toObject() };
        } catch (e) { if (e.code === 11000) return { error: 'Record already exists' }; throw e; }
      }
      return { error: 'Create not supported for: ' + collection };
    }

    // ---- UPDATE ----
    if (action === 'db_update') {
      if (!Model) return { error: 'Unknown collection' };
      if (!update) return { error: 'Update fields missing' };
      const r = await Model.updateMany(filter || {}, update);
      return { result: { matched: r.matchedCount, modified: r.modifiedCount } };
    }

    // ---- DELETE ----
    if (action === 'db_delete') {
      if (!Model) return { error: 'Unknown collection' };
      if (collection === 'users' && !isAdmin) return { error: 'Only admin can delete users' };
      const r = await Model.deleteMany(filter || {});
      return { result: { deleted: r.deletedCount } };
    }

    // ---- PUBLISH PASSCODE ----
    if (action === 'db_publish_passcode') {
      if (!isAdmin) return { error: 'Only admin can publish passcode' };
      const type = data?.type || 'single_lecture';
      const durationMinutes = parseInt(data?.durationMinutes) || (type === 'full_day' ? 1440 : 5);
      const now = new Date();
      const todayStr = getISTDateString(now);
      const ds = await checkDateStatus(todayStr);
      if (ds.isBlocked) return { error: 'College closed today — no passcode needed.' };

      let passcode;
      let expiry = new Date(now.getTime() + durationMinutes * 60 * 1000);
      let key;
      if (type === 'single_lecture') {
        const period = getCurrentPeriod(userContext.branch || 'CSE');
        if (!period) return { error: 'No active lecture now.' };
        passcode = Math.floor(1000 + Math.random() * 9000).toString();
        key = `single_lecture_${todayStr}_${period.start}_pub`;
      } else {
        passcode = Math.floor(10000 + Math.random() * 90000).toString();
        key = `full_day_${todayStr}_pub`;
      }
      await Passcode.updateMany({ key }, { $set: { expiresAt: new Date(0) } });
      const doc = await new Passcode({ passcode, type, key, expiresAt: expiry, published: true, publishedAt: now, publishedBy: userContext.rollNo, durationMinutes }).save();
      return { result: { passcode, type, expiresAt: expiry, durationMinutes, published: true } };
    }

    // ---- CREATE ATTENDANCE REQUEST ----
    if (action === 'db_create_request') {
      if (!isStudent) return { error: 'Only students can submit attendance requests' };
      if (!data || !data.dates || !data.dates.length) return { error: 'Dates missing' };
      const validDates = data.dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (!validDates.length) return { error: 'No valid dates' };
      const req = await new AttendanceRequest({
        rollNo: userContext.rollNo,
        studentName: userContext.name,
        branch: userContext.branch,
        dates: validDates,
        subjects: data.subjects || [],
        reason: data.reason || 'Attendance correction',
        requestType: data.requestType || 'Attendance Correction',
        status: 'Pending'
      }).save();
      return { result: { requestId: req._id.toString(), dates: validDates, status: 'Pending' } };
    }

    // ---- REVIEW REQUEST ----
    if (action === 'db_review_request') {
      if (!isAdmin && !isFaculty) return { error: 'Only admin/faculty can review requests' };
      if (!data || !data.requestId) return { error: 'requestId missing' };
      const reqDoc = await AttendanceRequest.findById(data.requestId);
      if (!reqDoc) return { error: 'Request not found' };
      const decision = data.action === 'Approved' ? 'Approved' : (data.action === 'Rejected' ? 'Rejected' : null);
      if (!decision) return { error: 'Invalid action' };
      const reviewDates = data.dates || reqDoc.dates; // date-by-date support
      if (decision === 'Approved') {
        const b = reqDoc.branch || 'CSE';
        const tt = getTimetableForBranch(b);
        const FDN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        let marked = 0;
        for (const dStr of reviewDates) {
          const dObj = new Date(dStr + 'T00:00:00');
          const dayName = FDN[dObj.getDay()];
          const daySubs = (tt[dayName] || []).map(e => mapToCanonical(e.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          const subsToMark = reqDoc.subjects && reqDoc.subjects.length ? reqDoc.subjects : daySubs;
          for (const sub of subsToMark) {
            const exists = await Attendance.findOne({ rollNo: reqDoc.rollNo, subject: sub, date: dStr });
            if (!exists) {
              try {
                await new Attendance({ rollNo: reqDoc.rollNo, studentName: reqDoc.studentName, subject: sub, date: dStr, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'request-approved', isVerified: true, branch: b }).save();
                marked++;
              } catch (e) {}
            }
          }
        }
        reqDoc.status = 'Approved';
        reqDoc.reviewedDates = reviewDates;
      } else {
        reqDoc.status = 'Rejected';
        reqDoc.rejectedDates = reviewDates;
      }
      reqDoc.reviewedBy = userContext.rollNo;
      reqDoc.adminNote = data.note || '';
      await reqDoc.save();
      return { result: { requestId: reqDoc._id.toString(), status: reqDoc.status, reviewedDates: reviewDates } };
    }

    return { error: 'Unsupported action: ' + action };
  } catch (err) {
    console.error('DB execute error:', err);
    return { error: 'Execution failed: ' + err.message };
  }
}

// ============================================================
//  ROUTES
// ============================================================
app.get('/', (req, res) => res.send('BM Group ERP Active!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: GEMINI_API_KEYS.length > 0 ? 'gemini' : 'disabled',
  primaryModel: GEMINI_MODEL,
  fallbackModels: GEMINI_FALLBACK_MODELS,
  keysLoaded: GEMINI_API_KEYS.length,
  features: ['smart-context', 'database-assistant', 'file-analysis', 'pdf', 'images', 'requests', 'passcode-publish'],
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
    const doc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() } });
    if (doc) res.json({ valid: true });
    else res.status(400).json({ error: 'Invalid or expired.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PUBLIC PASSCODE (for students) ==========
app.get('/api/passcode/public/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const doc = await Passcode.findOne({ type, published: true, expiresAt: { $gt: new Date() } }).sort({ publishedAt: -1 });
    if (!doc) return res.json({ passcode: null, message: 'No published passcode active.' });
    res.json({ passcode: doc.passcode, type, expiresAt: doc.expiresAt, durationMinutes: doc.durationMinutes, publishedAt: doc.publishedAt });
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

// ========== ADMIN (existing) ==========
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

// ========== ATTENDANCE REQUESTS (Manual endpoints) ==========
app.post('/api/requests/create', async (req, res) => {
  try {
    const { rollNo, dates, subjects, reason, requestType } = req.body;
    if (!rollNo || !dates || !dates.length) return res.status(400).json({ error: 'rollNo and dates required' });
    const user = await User.findOne({ rollNo: rollNo.trim().toUpperCase(), role: 'student' });
    if (!user) return res.status(404).json({ error: 'Student not found' });
    const validDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (!validDates.length) return res.status(400).json({ error: 'No valid dates' });
    const reqDoc = await new AttendanceRequest({
      rollNo: user.rollNo, studentName: user.name, branch: user.branch || 'CSE',
      dates: validDates, subjects: subjects || [], reason: reason || 'Attendance correction',
      requestType: requestType || 'Attendance Correction'
    }).save();
    res.status(201).json({ message: 'Request submitted', request: reqDoc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/requests/my/:rollNo', async (req, res) => {
  try {
    const cr = req.params.rollNo.trim().toUpperCase();
    res.json(await AttendanceRequest.find({ rollNo: cr }).sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/requests/all/:requesterRollNo', async (req, res) => {
  try {
    const rrn = req.params.requesterRollNo.trim().toUpperCase();
    const req1 = await User.findOne({ rollNo: rrn });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only' });
    const filter = req1.role === 'faculty' ? { branch: req1.branch || 'CSE' } : {};
    res.json(await AttendanceRequest.find(filter).sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests/review/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, dates, note } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1 || (req1.role !== 'admin' && req1.role !== 'faculty')) return res.status(403).json({ error: 'Admin/Faculty only' });
    const reqDoc = await AttendanceRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'Request not found' });
    const reviewDates = dates && dates.length ? dates : reqDoc.dates;
    if (action === 'Approved') {
      const b = reqDoc.branch || 'CSE';
      const tt = getTimetableForBranch(b);
      const FDN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      let marked = 0;
      for (const dStr of reviewDates) {
        const dayName = FDN[new Date(dStr + 'T00:00:00').getDay()];
        const daySubs = (tt[dayName] || []).map(e => mapToCanonical(e.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
        const subsToMark = reqDoc.subjects.length ? reqDoc.subjects : daySubs;
        for (const sub of subsToMark) {
          const exists = await Attendance.findOne({ rollNo: reqDoc.rollNo, subject: sub, date: dStr });
          if (!exists) {
            try {
              await new Attendance({ rollNo: reqDoc.rollNo, studentName: reqDoc.studentName, subject: sub, date: dStr, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'request-approved', isVerified: true, branch: b }).save();
              marked++;
            } catch (e) {}
          }
        }
      }
      reqDoc.status = 'Approved';
      reqDoc.reviewedDates = reviewDates;
    } else {
      reqDoc.status = 'Rejected';
      reqDoc.rejectedDates = reviewDates;
    }
    reqDoc.reviewedBy = req1.rollNo;
    reqDoc.adminNote = note || '';
    await reqDoc.save();
    res.json({ message: `Request ${action.toLowerCase()}`, request: reqDoc });
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

// ========== PASSCODE ==========
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type, force, publish, durationMinutes } = req.body;
    const req1 = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!req1) return res.status(403).json({ error: 'User not found!' });
    if (req1.role === 'admin') { /* ok */ }
    else if (req1.role === 'faculty' && type === 'single_lecture') { /* ok */ }
    else return res.status(403).json({ error: 'Access Denied.' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const todayStr = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayStr);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.type === 'WEEKEND' ? `📅 ${dateStatus.dayName}: College closed.` : `🎉 ${dateStatus.holiday || 'Holiday'}: College closed.`, blocked: true });
    if (type === 'single_lecture') {
      const branch = req1.branch || 'CSE';
      const period = getCurrentPeriod(branch);
      if (!period) return res.status(400).json({ error: 'No active lecture.' });
      const now = new Date();
      const ds = getISTDateString(now);
      const key = `single_lecture_${ds}_${period.start}`;
      if (force) { await Passcode.deleteMany({ key, type: 'single_lecture' }); }
      else { let doc = await Passcode.findOne({ key, type: 'single_lecture' }); if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing', passcode: doc.passcode, type, expiresAt: doc.expiresAt }); }
      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const expiry = new Date(now.getTime() + 5 * 60 * 1000);
      await new Passcode({ passcode, type, key, expiresAt: expiry, published: !!publish, publishedAt: publish ? now : null, publishedBy: publish ? req1.rollNo : null, durationMinutes: publish ? (parseInt(durationMinutes) || 5) : null }).save();
      await Passcode.deleteMany({ type: 'single_lecture', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : 'Generated', passcode, type, expiresAt: expiry, changed: !!force, published: !!publish });
    }
    if (type === 'full_day') {
      const now = new Date();
      const ds = getISTDateString(now);
      const key = `full_day_${ds}`;
      if (force) { await Passcode.deleteMany({ key, type: 'full_day' }); }
      else { let doc = await Passcode.findOne({ key, type: 'full_day' }); if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing', passcode: doc.passcode, type, expiresAt: doc.expiresAt }); }
      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiry = new Date(now); expiry.setHours(23, 59, 59, 999);
      await new Passcode({ passcode, type, key, expiresAt: expiry, published: !!publish, publishedAt: publish ? now : null, publishedBy: publish ? req1.rollNo : null, durationMinutes: publish ? (parseInt(durationMinutes) || 1440) : null }).save();
      await Passcode.deleteMany({ type: 'full_day', expiresAt: { $lt: new Date() } });
      return res.json({ message: force ? 'Changed' : 'Generated', passcode, type, expiresAt: expiry, changed: !!force, published: !!publish });
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
    const key2 = `single_lecture_${todayDate}_${period.start}_pub`;
    const doc = await Passcode.findOne({ $or: [{ key }, { key: key2, published: true }], type: 'single_lecture', passcode, expiresAt: { $gt: new Date() } });
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
    const summary = await getStudentSummary(req.params.rollNo.trim().toUpperCase());
    if (!summary) return res.status(404).json({ error: 'Not found!' });
    res.json(summary);
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
//  UNIFIED CHATBOT — Smart Context + Database Assistant
// ============================================================
function buildShortWelcome(role, userName) {
  if (role === 'admin') return `Namaste ${userName}! 👋 Admin panel ready. Context aur Database toggle kar sakte ho detailed features ke liye.`;
  if (role === 'faculty') return `Namaste ${userName}! 👋 Faculty mode ready. Context on karo students ke details ke liye, Database on karo attendance mark karne ke liye.`;
  return `Namaste ${userName}! 👋 Kya help chahiye? Attendance, timetable, notes ya kuch aur — bas pucho!`;
}

function buildDetailedWelcome(role, userName) {
  if (role === 'admin') return `Namaste ${userName} 👋\n\nMain aapka **Admin Assistant** hun. Aap ye sab kar sakte ho:\n• 📊 Attendance reports aur defaulters\n• 📢 Notice publish karna\n• 🎉 Holiday declare karna\n• 🔐 Passcode generate/publish karna\n• 📋 Student requests review karna\n• 👥 User management\n\n**Database toggle ON** karke seedha bol sakte ho: "Diwali holiday add karo 25 Oct", "Notice post karo" etc.`;
  if (role === 'faculty') return `Namaste ${userName} 👋\n\nMain aapka **Faculty Assistant** hun:\n• 📚 Aapke assigned subjects ke students\n• ✅ Attendance mark karna (passcode ke sath)\n• 🔐 Lecture passcode generate karna\n• 📊 Class average aur reports\n• 📋 Student requests review karna\n\n**Database toggle ON** karke direct commands de sakte ho.`;
  return `Namaste ${userName} 👋\n\nMain aapka **BM Bot** hun. Aap ye kar sakte ho:\n• 📊 Apni attendance check karna\n• 🗓️ Timetable dekhna\n• 🎉 Holidays jaanna\n• 📝 Notes/study material\n• 💻 Coding help\n• 📩 Attendance correction request bhejna\n\n**Context ON** → aapka personal data use hoga\n**Database ON** → attendance request bhej sakte ho`;
}

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId, skipGreeting, useContext, useDatabase } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const cr = rollNo?.trim().toUpperCase() || 'guest';
    const useCtx = useContext === true;
    const useDb = useDatabase === true;

    let userData = null, existingChat = null;
    if (cr !== 'guest') {
      try { userData = await User.findOne({ rollNo: cr }); } catch(e){}
      if (threadId) {
        try { existingChat = await Chat.findOne({ threadId, rollNo: cr }); } catch (e) { console.warn('Chat history fetch failed:', e.message); }
      }
    }

    const userRole = userData?.role || role || 'student';
    const userName = userData?.name || name || 'Guest';

    // ===== DATABASE MODE =====
    if (useDb && userData) {
      try {
        const intent = await detectIntent(message, {
          role: userRole, rollNo: cr, name: userName, branch: userData.branch || 'CSE'
        });
        console.log('🧠 Intent:', JSON.stringify(intent).substring(0, 300));

        // If it's a pure reply intent, fall through to normal AI chat
        if (intent.action !== 'reply') {
          // Execute DB action (with role checks)
          if (intent.requiresConfirmation) {
            // Send to frontend for confirmation
            // We still store chat
            if (cr !== 'guest') {
              const autoTitle = message.substring(0, 50) || 'DB op';
              if (existingChat) {
                existingChat.messages.push({ role: 'user', content: message });
                existingChat.messages.push({ role: 'assistant', content: `[Pending confirmation] ${intent.explanation}` });
                existingChat.updatedAt = new Date();
                await existingChat.save();
                return res.json({ reply: `⚠️ ${intent.explanation}\n\nConfirm karo:`, threadId: existingChat.threadId, title: existingChat.title, aiOk: true, usedContext: useCtx, usedDatabase: true, dbOp: intent, requiresConfirmation: true });
              } else {
                const nt = new Chat({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: autoTitle, messages: [{ role: 'user', content: message }, { role: 'assistant', content: `[Pending] ${intent.explanation}` }] });
                await nt.save();
                return res.json({ reply: `⚠️ ${intent.explanation}\n\nConfirm karo:`, threadId: nt.threadId, title: autoTitle, aiOk: true, usedContext: useCtx, usedDatabase: true, dbOp: intent, requiresConfirmation: true });
              }
            }
            return res.json({ reply: `⚠️ ${intent.explanation}\n\nConfirm karo:`, threadId: threadId, title: 'New Chat', aiOk: true, usedContext: useCtx, usedDatabase: true, dbOp: intent, requiresConfirmation: true });
          }

          // Execute immediately
          const execResult = await executeDbAction(intent, {
            role: userRole, rollNo: cr, name: userName, branch: userData.branch || 'CSE'
          });

          let replyText = execResult.error
            ? `❌ ${execResult.error}`
            : `✅ ${intent.explanation}\n\n${formatResult(execResult.result)}`;

          // Save chat
          if (cr !== 'guest') {
            const autoTitle = message.substring(0, 50) || 'DB op';
            if (existingChat) {
              existingChat.messages.push({ role: 'user', content: message });
              existingChat.messages.push({ role: 'assistant', content: replyText });
              existingChat.updatedAt = new Date();
              await existingChat.save();
              return res.json({ reply: replyText, threadId: existingChat.threadId, title: existingChat.title, aiOk: true, usedContext: useCtx, usedDatabase: true, dbResult: execResult.result, dbError: execResult.error });
            } else {
              const nt = new Chat({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: autoTitle, messages: [{ role: 'user', content: message }, { role: 'assistant', content: replyText }] });
              await nt.save();
              return res.json({ reply: replyText, threadId: nt.threadId, title: autoTitle, aiOk: true, usedContext: useCtx, usedDatabase: true, dbResult: execResult.result, dbError: execResult.error });
            }
          }
          return res.json({ reply: replyText, threadId: threadId, title: 'New Chat', aiOk: true, usedContext: useCtx, usedDatabase: true, dbResult: execResult.result, dbError: execResult.error });
        }
        // else fall through to normal chat using intent.reply as hint
        if (intent.reply) {
          // Reply provided by intent detection
          if (cr !== 'guest') {
            const autoTitle = message.substring(0, 50) || 'Chat';
            if (existingChat) {
              existingChat.messages.push({ role: 'user', content: message });
              existingChat.messages.push({ role: 'assistant', content: intent.reply });
              existingChat.updatedAt = new Date();
              await existingChat.save();
              return res.json({ reply: intent.reply, threadId: existingChat.threadId, title: existingChat.title, aiOk: true, usedContext: useCtx, usedDatabase: true });
            } else {
              const nt = new Chat({ rollNo: cr, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: autoTitle, messages: [{ role: 'user', content: message }, { role: 'assistant', content: intent.reply }] });
              await nt.save();
              return res.json({ reply: intent.reply, threadId: nt.threadId, title: autoTitle, aiOk: true, usedContext: useCtx, usedDatabase: true });
            }
          }
          return res.json({ reply: intent.reply, threadId: threadId, title: 'Chat', aiOk: true, usedContext: useCtx, usedDatabase: true });
        }
      } catch (err) {
        console.warn('DB mode error, falling back to normal chat:', err.message);
      }
    }

    // ===== NORMAL CHAT MODE =====
    // ✅ SMART CONTEXT — only if user explicitly enabled useContext
    let contextStr = '';
    if (useCtx && userData) {
      const needs = detectContextNeeds(message);
      const lines = [];
      lines.push(`Date/time: ${new Date().toLocaleString()}`);
      lines.push(`User: ${userData.name} (${userData.rollNo}, ${userData.role})`);
      lines.push(`Branch: ${userData.branch || 'CSE'}`);

      if (needs.attendance || needs.currentPeriod) {
        try {
          const summary = await getStudentSummary(userData.rollNo);
          if (summary) {
            lines.push(`Attendance: ${summary.attendancePercentage}% (${summary.totalAcademicLectures}/${summary.totalConductedLectures})`);
            if (needs.attendance && summary.subjectStats) {
              const subLines = Object.entries(summary.subjectStats).map(([sub, st]) => `  • ${sub}: ${st.present}/${st.total} (${st.percentage}%)`);
              lines.push('Subject-wise:');
              lines.push(...subLines);
            }
          }
        } catch(e) { console.warn('Attendance fetch failed:', e.message); }
      }

      if (needs.holiday) {
        try {
          const today = new Date();
          const startStr = getISTDateString(SEMESTER_START);
          const todayStr = getISTDateString(today);
          const holidays = await Holiday.find({ date: { $gte: startStr, $lte: todayStr } });
          if (holidays.length) lines.push(`Holidays: ${holidays.map(h => `${h.date} (${h.reason})`).join(', ')}`);
        } catch(e) {}
      }

      if (needs.timetable || needs.currentPeriod) {
        try {
          const todayDay = new Date().toLocaleString('en', { weekday: 'long' });
          const tt = getTimetableForBranch(userData.branch || 'CSE')[todayDay] || [];
          lines.push(`Today (${todayDay}): ${tt.map(s => s.subject).join(', ')}`);
          const currentPeriod = getCurrentPeriod(userData.branch || 'CSE');
          if (currentPeriod) lines.push(`Current period: ${currentPeriod.subject} (${currentPeriod.start}-${currentPeriod.end})`);
        } catch(e) {}
      }

      if (needs.passcode) {
        try {
          const now = new Date();
          const activePubs = await Passcode.find({ published: true, expiresAt: { $gt: now } });
          if (activePubs.length) lines.push(`Active public passcodes: ${activePubs.map(p => `${p.type}=${p.passcode}`).join(', ')}`);
        } catch(e) {}
      }

      contextStr = lines.join('\n');
    }

    const now = new Date();
    const hour = now.getHours();
    let greeting = '', emoji = '';
    if (!skipGreeting) {
      if (hour < 12) { greeting = 'Good morning'; emoji = '🌞'; }
      else if (hour < 17) { greeting = 'Good afternoon'; emoji = '🌤️'; }
      else { greeting = 'Good evening'; emoji = '🌙'; }
    }

    // Build system prompt based on context
    let systemPrompt;
    if (!useCtx) {
      // Short, no personal context
      systemPrompt = `You are "BM Bot" for BM Group of Institutions attendance portal.
${greeting ? greeting + ', ' + userName + ' ' + emoji + '!' : ''}
Assisting ${userRole}.
Role:
- Answer questions on general topics, attendance help, timetable info, holidays, notes, coding.
- Keep responses FRIENDLY and CONCISE unless asked for detailed notes.
- If user asks for their personal attendance/timetable/holidays — politely suggest they turn ON "Context" toggle.
- Use Hinglish/English as user does.
- NEVER use markdown tables. Use bullet points.`;
    } else {
      // Detailed with context
      const ctxBlock = contextStr ? `\nContext:\n${contextStr}` : '';
      systemPrompt = `You are "BM Bot" for BM Group of Institutions attendance portal.
${greeting ? greeting + ', ' + userName + ' ' + emoji + '!' : ''}
Assisting ${userRole}.${ctxBlock}
Role:
- Answer questions on attendance, timetable, holidays, notes, coding, general help.
- Use the provided context when relevant.
- If user asks "kitne bunk kar sakta hun" — calculate using 75% rule.
- If asked for notes — provide with headings, bullets, examples.
- Warn politely if attendance below 75%.
- Be friendly, encouraging, use emojis.
- Use Hinglish/English as user does.
- NEVER use markdown tables. Use bullet points for comparison.`;
    }

    let reply = '';
    let aiOk = false;
    try {
      reply = await callGemini({
        prompt: message,
        systemPrompt,
        history: existingChat?.messages,
        maxTokens: useCtx ? 1500 : 800,
        temperature: 0.7,
        timeoutMs: 12000,
        globalTimeoutMs: 45000,
        maxAttempts: 6
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

    res.json({ reply, threadId: newThreadId, title: newTitle, aiOk, usedContext: useCtx, usedDatabase: useDb });
  } catch (err) {
    console.error('❌ Chat error:', err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

function formatResult(result) {
  if (!result) return 'Done.';
  if (typeof result === 'object') {
    if (result.count !== undefined) return `Count: ${result.count}`;
    if (result.deleted !== undefined) return `Deleted: ${result.deleted}`;
    if (result.modified !== undefined) return `Modified: ${result.modified}`;
    if (result.passcode) return `Passcode: **${result.passcode}**\nType: ${result.type}\nExpires: ${new Date(result.expiresAt).toLocaleString('en-IN')}\nPublished: ${result.published ? 'Yes ✅' : 'No'}`;
    if (result.attendancePercentage !== undefined) {
      const weak = Object.entries(result.subjectStats || {}).filter(([_, s]) => s.percentage < 75);
      let txt = `Overall: **${result.attendancePercentage}%** (${result.attended}/${result.conducted})`;
      if (weak.length) txt += `\n\n⚠️ Low subjects:\n${weak.map(([s, st]) => `• ${s}: ${st.percentage}%`).join('\n')}`;
      return txt;
    }
    if (result.requestId) return `Request ID: ${result.requestId}\nDates: ${result.dates.join(', ')}\nStatus: ${result.status}`;
    if (Array.isArray(result)) {
      if (!result.length) return 'No records found.';
      return `${result.length} record(s):\n${result.slice(0, 5).map(r => JSON.stringify(r)).join('\n')}${result.length > 5 ? '\n...' : ''}`;
    }
  }
  return JSON.stringify(result);
}

// Confirm pending DB operation
app.post('/api/ai/chat/confirm-db', async (req, res) => {
  try {
    const { rollNo, operation } = req.body;
    if (!rollNo || !operation) return res.status(400).json({ error: 'rollNo and operation required' });
    const userData = await User.findOne({ rollNo: rollNo.trim().toUpperCase() });
    if (!userData) return res.status(404).json({ error: 'User not found' });
    const execResult = await executeDbAction(operation, {
      role: userData.role, rollNo: userData.rollNo, name: userData.name, branch: userData.branch || 'CSE'
    });
    const replyText = execResult.error
      ? `❌ ${execResult.error}`
      : `✅ ${operation.explanation || 'Done'}\n\n${formatResult(execResult.result)}`;
    res.json({ reply: replyText, aiOk: true, dbResult: execResult.result, dbError: execResult.error });
  } catch (err) {
    console.error('❌ Confirm DB error:', err);
    res.status(500).json({ error: err.message });
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

    const allowed = ['application/pdf','text/plain','image/jpeg','image/jpg','image/png','image/webp','image/gif'];
    const isAllowed = allowed.some(t => mimeType === t || mimeType.includes(t));
    if (!isAllowed) return res.status(400).json({ error: `Unsupported file type: ${mimeType}.` });

    const cr = rollNo?.trim().toUpperCase() || 'guest';
    let userData = null;
    if (cr !== 'guest') userData = await User.findOne({ rollNo: cr });
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';

    const fileLabels = { pdf: 'PDF document', plain: 'text file', jpeg: 'image (JPEG)', jpg: 'image (JPEG)', png: 'image (PNG)', webp: 'image (WebP)', gif: 'image (GIF)' };
    const subtype = mimeType.split('/')[1];
    const fileTypeLabel = fileLabels[subtype] || 'file';

    const systemPrompt = `You are "BM Bot" for BM Group.
Helping ${userName} (${userRole}) with a ${fileTypeLabel}.
Task:
- Carefully read/analyze the uploaded ${fileTypeLabel}.
- If image — describe contents, extract text if any, answer user's question about it.
- If PDF/text — extract, summarize, explain.
- If code file — explain the code, fix bugs, improve.
- Use markdown formatting: headings, bullets, bold.
- NEVER use markdown tables. Use bullet points instead.
- Respond in user's language (Hindi/English).`;

    let reply = '';
    let aiOk = false;
    try {
      reply = await callGemini({
        prompt: userPrompt, systemPrompt, fileBase64, mimeType,
        maxTokens: 3000, temperature: 0.4,
        timeoutMs: 20000, globalTimeoutMs: 90000, maxAttempts: 12
      });
      aiOk = true;
    } catch (err) {
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
//  AI: Generate PDF Report (kept from before)
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
          `Status: ${summary.attendancePercentage >= 75 ? '✅ Safe' : '⚠️ Below 75%'}`
        ]},
        { heading: '📚 Subject-wise', table: { headers: ['Subject', 'Present/Total', 'Percentage'], rows: subRows } },
        { heading: '📅 Recent 30 Records', table: { headers: ['Date', 'Subject', 'Status'], rows: records.slice(-30).reverse().map(r => [r.date, mapToCanonical(r.subject), r.status]) } }
      ];
      pdfBuffer = await generatePDFBuffer({ title: 'Student Attendance Report', subtitle: `${targetUser.name} (${target}) • ${targetUser.branch || 'CSE'}`, sections });
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
      pdfBuffer = await generatePDFBuffer({ title: 'Defaulter Watchlist', subtitle: `Threshold: ${threshold}%`, sections });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=defaulters_${threshold}pct.pdf`);
      return res.send(pdfBuffer);
    }

    res.status(400).json({ error: 'Unknown reportType.' });
  } catch (err) { console.error('❌ PDF report error:', err); res.status(500).json({ error: err.message }); }
});

// ---------- Global Handlers ----------
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); process.exit(1); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT} | AI: ${GEMINI_API_KEYS.length} keys | Primary: ${GEMINI_MODEL} | Features: Context + Database Assistant + Requests + Passcode Publish`));
