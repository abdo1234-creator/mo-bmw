/* FILE: db.js | PURPOSE: SQLite schema, connection and first-run seed data | DEPENDS ON: node:sqlite (built-in), bcryptjs */
const path = require('path');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// better-sqlite3-style transaction helper: db.transaction(fn) -> callable wrapped in BEGIN/COMMIT
db.transaction = function (fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  };
};

db.exec(`
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  years TEXT,
  img_url TEXT,
  tags TEXT DEFAULT '[]',
  series_id TEXT DEFAULT NULL,
  series_banner_url TEXT DEFAULT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  category TEXT NOT NULL,
  oem TEXT,
  price_egp REAL NOT NULL DEFAULT 0,
  note TEXT,
  badge TEXT DEFAULT 'oem',
  in_stock INTEGER DEFAULT 1,
  discount_id INTEGER,
  img_url TEXT DEFAULT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('percent','fixed')),
  value REAL NOT NULL,
  applies_to TEXT NOT NULL CHECK(applies_to IN ('all_parts','category','specific_part','booking')),
  target_id TEXT,
  expiry_date TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  car TEXT,
  stars INTEGER DEFAULT 5,
  quote TEXT,
  visible INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  event_type TEXT,
  badge_class TEXT,
  event_date TEXT,
  event_time TEXT,
  location TEXT,
  price_egp REAL DEFAULT 0,
  total_spots INTEGER DEFAULT 0,
  remaining_spots INTEGER DEFAULT 0,
  image_url TEXT,
  is_upcoming INTEGER DEFAULT 1,
  visible INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_number TEXT UNIQUE NOT NULL,
  service_type TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  car_model TEXT,
  slot_datetime TEXT,
  issue_description TEXT,
  address TEXT,
  delivery_range TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
  admin_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid_name TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  entity_type TEXT,
  entity_id TEXT,
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS newsletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  subscribed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT UNIQUE NOT NULL,
  customer_name TEXT DEFAULT NULL,
  customer_phone TEXT DEFAULT NULL,
  car_model TEXT DEFAULT '',
  total_spent_egp REAL DEFAULT 0,
  car_status TEXT NOT NULL DEFAULT 'ready' CHECK(car_status IN ('ready','in_service')),
  last_service_date TEXT DEFAULT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS part_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  series_id TEXT NOT NULL,
  model_id INTEGER DEFAULT NULL REFERENCES models(id) ON DELETE SET NULL,
  engine_code TEXT DEFAULT NULL,
  UNIQUE(part_id, series_id, model_id, engine_code)
);
CREATE INDEX IF NOT EXISTS idx_pa_part ON part_assignments(part_id);
CREATE INDEX IF NOT EXISTS idx_pa_series ON part_assignments(series_id, model_id, engine_code);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_number TEXT UNIQUE NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  customer_name TEXT,
  delivery_address TEXT,
  delivery_range TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
  payment_method TEXT DEFAULT NULL,
  payment_status TEXT DEFAULT NULL,
  payment_screenshot_url TEXT DEFAULT NULL,
  payment_confirmed_at TEXT DEFAULT NULL,
  payment_admin_note TEXT DEFAULT NULL,
  agreed_amount REAL DEFAULT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  admin_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  part_name TEXT NOT NULL,
  part_oem TEXT,
  unit_price REAL NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

// Defensive migration: add img_url to parts if this DB predates the column.
try {
  const cols = db.prepare("PRAGMA table_info(parts)").all();
  if (!cols.some(c => c.name === 'img_url')) {
    db.exec('ALTER TABLE parts ADD COLUMN img_url TEXT DEFAULT NULL');
  }
} catch { /* column already present */ }

// Defensive migration: add series_id / series_banner_url to models if this DB predates them.
try {
  const modelCols = db.prepare("PRAGMA table_info(models)").all();
  if (!modelCols.some(c => c.name === 'series_id')) {
    db.exec('ALTER TABLE models ADD COLUMN series_id TEXT DEFAULT NULL');
  }
  if (!modelCols.some(c => c.name === 'series_banner_url')) {
    db.exec('ALTER TABLE models ADD COLUMN series_banner_url TEXT DEFAULT NULL');
  }
} catch { /* columns already present */ }

// Defensive migration: add customer_name / customer_phone to customers if this DB predates them.
try {
  const customerCols = db.prepare("PRAGMA table_info(customers)").all();
  if (!customerCols.some(c => c.name === 'customer_name')) {
    db.exec('ALTER TABLE customers ADD COLUMN customer_name TEXT DEFAULT NULL');
  }
  if (!customerCols.some(c => c.name === 'customer_phone')) {
    db.exec('ALTER TABLE customers ADD COLUMN customer_phone TEXT DEFAULT NULL');
  }
} catch { /* columns already present */ }

// Defensive migration: add payment fields to bookings if this DB predates them.
try {
  const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  if (!bookingCols.includes('payment_method')) db.exec("ALTER TABLE bookings ADD COLUMN payment_method TEXT DEFAULT NULL");
  if (!bookingCols.includes('payment_status')) db.exec("ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT NULL");
  if (!bookingCols.includes('payment_screenshot_url')) db.exec("ALTER TABLE bookings ADD COLUMN payment_screenshot_url TEXT DEFAULT NULL");
  if (!bookingCols.includes('payment_confirmed_at')) db.exec("ALTER TABLE bookings ADD COLUMN payment_confirmed_at TEXT DEFAULT NULL");
  if (!bookingCols.includes('payment_admin_note')) db.exec("ALTER TABLE bookings ADD COLUMN payment_admin_note TEXT DEFAULT NULL");
  if (!bookingCols.includes('agreed_amount')) db.exec("ALTER TABLE bookings ADD COLUMN agreed_amount REAL DEFAULT NULL");
  if (!bookingCols.includes('tuning_stage')) db.exec("ALTER TABLE bookings ADD COLUMN tuning_stage TEXT DEFAULT NULL");
} catch { /* columns already present */ }

// Defensive migration: restructure tuning_stages from the old 3-tier (1,2,3/custom)
// shape into the 4-tier shape (1, 2, 2+, custom) — preserves any admin-edited
// values for stage 1/2/old-stage-3 (renamed to "custom"), only adds the new "2+" tier.
try {
  const row = db.prepare("SELECT value FROM service_config WHERE key = 'tuning_stages'").get();
  if (row) {
    const stages = JSON.parse(row.value);
    const hasStringStages = stages.some(s => typeof s.stage === 'string');
    if (!hasStringStages) {
      const s1 = stages.find(s => Number(s.stage) === 1);
      const s2 = stages.find(s => Number(s.stage) === 2);
      const s3 = stages.find(s => Number(s.stage) === 3);
      const rebuilt = [];
      if (s1) rebuilt.push({ ...s1, stage: '1', stage_label: 'STAGE 1' });
      if (s2) rebuilt.push({ ...s2, stage: '2', stage_label: 'STAGE 2' });
      rebuilt.push({
        stage: '2+', stage_label: 'STAGE 2+',
        hp_label: '+120–160 HP', price: 45000,
        features: ['Stage 2 Remap + Hardware', 'Upgraded Intercooler', 'High-Flow Fuel System', 'Dyno test + before/after'],
        contact_only: false, visible: true
      });
      if (s3) rebuilt.push({ ...s3, stage: 'custom', stage_label: 'CUSTOM TUNING' });
      db.prepare("UPDATE service_config SET value = ? WHERE key = 'tuning_stages'").run(JSON.stringify(rebuilt));
    }
  }
} catch { /* tuning_stages already migrated or malformed — leave as-is */ }

// Defensive migration: ensure payment settings keys exist on DBs that predate them
// (seedIfEmpty only seeds site_settings when the table is completely empty).
try {
  const paymentDefaults = {
    payment_cash_enabled: 'true',
    payment_bank_enabled: 'false',
    payment_wallet_enabled: 'false',
    payment_bank_name: '',
    payment_bank_holder: '',
    payment_bank_account: '',
    payment_wallet_provider: 'Vodafone Cash / InstaPay',
    payment_wallet_number: ''
  };
  const insIfMissing = db.prepare('INSERT INTO site_settings (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE key = ?)');
  Object.entries(paymentDefaults).forEach(([k, v]) => insIfMissing.run(k, v, k));
} catch { /* keys already present */ }

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('Admin@1234', 12);
    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('admin', hash);
  }

  const modelCount = db.prepare('SELECT COUNT(*) c FROM models').get().c;
  if (modelCount === 0) {
    const MODELS = [
      {name:"BMW M2",years:"2023–2025",img:"https://images.dealer.com/ddc/vehicles/2023/BMW/M2/Coupe/perspective/front-left/2023_24.png",tags:["track","m-perf"]},
      {name:"BMW M3 Competition",years:"2021–2025",img:"https://images.dealer.com/ddc/vehicles/2021/BMW/M3/Sedan/perspective/front-left/2021_24.png",tags:["popular","m-perf"]},
      {name:"BMW M4 CSL",years:"2022–2025",img:"https://images.dealer.com/ddc/vehicles/2022/BMW/M4/Coupe/perspective/front-left/2022_24.png",tags:["track","m-perf"]},
      {name:"BMW M5",years:"2024–2025",img:"https://images.dealer.com/ddc/vehicles/2024/BMW/M5/Sedan/perspective/front-left/2024_24.png",tags:["popular","m-perf"]},
      {name:"BMW M8 Gran Coupe",years:"2020–2025",img:"https://images.dealer.com/ddc/vehicles/2020/BMW/M8/Coupe/perspective/front-left/2020_24.png",tags:["track"]},
      {name:"BMW X5 M",years:"2020–2025",img:"https://images.dealer.com/ddc/vehicles/2020/BMW/X5-M/SUV/perspective/front-left/2020_24.png",tags:["popular"]},
      {name:"BMW X6 M",years:"2020–2025",img:"https://images.dealer.com/ddc/vehicles/2020/BMW/X6-M/SUV/perspective/front-left/2020_24.png",tags:["m-perf"]},
      {name:"BMW 3 Series",years:"2019–2025",img:"https://images.dealer.com/ddc/vehicles/2023/BMW/3-Series/Sedan/perspective/front-left/2023_24.png",tags:["popular"]},
      {name:"BMW 5 Series",years:"2017–2023",img:"https://images.dealer.com/ddc/vehicles/2021/BMW/5-Series/Sedan/perspective/front-left/2021_24.png",tags:["popular"]},
      {name:"BMW 7 Series",years:"2023–2025",img:"https://images.dealer.com/ddc/vehicles/2023/BMW/7-Series/Sedan/perspective/front-left/2023_24.png",tags:["popular"]},
      {name:"BMW Z4 Roadster",years:"2019–2025",img:"https://images.dealer.com/ddc/vehicles/2023/BMW/Z4/Convertible/perspective/front-left/2023_24.png",tags:["track"]},
      {name:"BMW i4 M50",years:"2022–2025",img:"https://images.dealer.com/ddc/vehicles/2022/BMW/i4/Sedan/perspective/front-left/2022_24.png",tags:["m-perf"]}
    ];
    const ins = db.prepare('INSERT INTO models (name, years, img_url, tags, sort_order) VALUES (?,?,?,?,?)');
    MODELS.forEach((m, i) => ins.run(m.name, m.years, m.img, JSON.stringify(m.tags), i));
  }

  const partCount = db.prepare('SELECT COUNT(*) c FROM parts').get().c;
  if (partCount === 0) {
    const PARTS = [
      {cat:"Engine",ar:"زيت محرك Castrol",en:"Engine Oil 5L",oem:"83-21-2-365-947",price:450,note:"5L",badge:"oem",stock:true},
      {cat:"Engine",ar:"فلتر زيت",en:"Oil Filter",oem:"11-42-7-953-129",price:180,note:"OEM",badge:"oem",stock:true},
      {cat:"Engine",ar:"فلتر هواء",en:"Air Filter",oem:"13-71-7-599-285",price:220,note:"OEM",badge:"oem",stock:true},
      {cat:"Engine",ar:"شمع إشعال NGK",en:"Spark Plugs Set×4",oem:"12-12-0-034-959",price:380,note:"Set×4",badge:"compat",stock:true},
      {cat:"Engine",ar:"بمبة مياه",en:"Water Pump",oem:"11-51-7-586-925",price:1200,note:"OEM",badge:"oem",stock:false},
      {cat:"Engine",ar:"ثرموستات",en:"Thermostat",oem:"11-53-7-549-476",price:650,note:"OEM",badge:"oem",stock:true},
      {cat:"Brakes",ar:"تيل فرامل أمامية",en:"Front Brake Pads",oem:"34-11-6-794-298",price:1800,note:"Brembo/Axle",badge:"compat",stock:true},
      {cat:"Brakes",ar:"تيل فرامل خلفية",en:"Rear Brake Pads",oem:"34-21-6-794-300",price:1400,note:"Brembo/Axle",badge:"compat",stock:true},
      {cat:"Brakes",ar:"دسكات أمامية",en:"Front Rotors",oem:"34-10-6-797-603",price:2200,note:"Pair",badge:"oem",stock:false},
      {cat:"Brakes",ar:"دسكات خلفية",en:"Rear Rotors",oem:"34-20-6-797-605",price:1800,note:"Pair",badge:"oem",stock:false},
      {cat:"Suspension",ar:"أمورتيسور أمامي",en:"Front Shock Absorber",oem:"31-31-6-796-760",price:3500,note:"Each",badge:"oem",stock:true},
      {cat:"Suspension",ar:"أمورتيسور خلفي",en:"Rear Shock Absorber",oem:"33-52-6-796-762",price:3000,note:"Each",badge:"oem",stock:false},
      {cat:"Suspension",ar:"حاملة عجل أمامية",en:"Front Wheel Hub",oem:"31-12-6-796-350",price:1500,note:"Each",badge:"oem",stock:true},
      {cat:"Suspension",ar:"لينكات تعليق",en:"Suspension Links",oem:"31-35-6-757-154",price:450,note:"Each",badge:"compat",stock:true},
      {cat:"Electrical",ar:"بطارية AGM 90Ah",en:"AGM Battery 90Ah",oem:"61-21-8-583-483",price:3200,note:"AGM",badge:"oem",stock:true},
      {cat:"Electrical",ar:"دينامو 180A",en:"Alternator 180A",oem:"12-31-7-546-918",price:4500,note:"Reman",badge:"oem",stock:false},
      {cat:"Electrical",ar:"بادئ تشغيل",en:"Starter Motor",oem:"12-41-7-616-100",price:2800,note:"Reman",badge:"oem",stock:true},
      {cat:"Electrical",ar:"سينسور Lambda",en:"O2 Sensor",oem:"11-78-7-548-990",price:850,note:"OEM",badge:"oem",stock:true},
      {cat:"Tuning",ar:"ECU Tune Stage 1",en:"ECU Remap Stage 1",oem:"Custom",price:8500,note:"+50HP",badge:"perf",stock:true},
      {cat:"Tuning",ar:"Intake Kit Carbon",en:"Carbon Intake Kit",oem:"AFE-54-12272-C",price:6200,note:"+15HP",badge:"perf",stock:true},
      {cat:"Tuning",ar:"Catback Exhaust",en:"Titanium Catback",oem:"AKRAPOVIC-custom",price:28000,note:"Titanium",badge:"perf",stock:false},
      {cat:"Tuning",ar:"Lowering Springs",en:"H&R Lowering Springs",oem:"H&R-29041-2",price:5500,note:"-30mm",badge:"perf",stock:true},
      {cat:"Tuning",ar:"Carbon Hood",en:"Carbon Fiber Hood",oem:"Custom-M",price:18000,note:"Full CF",badge:"perf",stock:false},
      {cat:"Tuning",ar:"M Sport Bodykit",en:"Full M Sport Bodykit",oem:"OEM-M-upgrade",price:45000,note:"Full Set",badge:"perf",stock:false}
    ];
    const ins = db.prepare('INSERT INTO parts (name_ar, name_en, category, oem, price_egp, note, badge, in_stock, sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
    PARTS.forEach((p, i) => ins.run(p.ar, p.en, p.cat, p.oem, p.price, p.note, p.badge, p.stock ? 1 : 0, i));
  }

  const testiCount = db.prepare('SELECT COUNT(*) c FROM testimonials').get().c;
  if (testiCount === 0) {
    const TESTIMONIALS = [
      {name:"Ahmed K.",city:"Cairo",car:"BMW M4",stars:5,quote:"Best place I've had tuning done on my M4. The results exceeded my expectations by far — the power gain is seriously noticeable!"},
      {name:"Mohamed S.",city:"Giza",car:"BMW 5 Series",stars:5,quote:"Extremely professional team, clean work and very fair prices. I recommend them to every BMW owner in Egypt."},
      {name:"Karim A.",city:"Alexandria",car:"BMW X5",stars:5,quote:"Booked a quick service and was done in exactly an hour! Excellent, fast service and very respectful staff."},
      {name:"Sara M.",city:"6th October",car:"BMW M3",stars:5,quote:"They did a full body kit for my M3. The work is 100% professional and the pricing was very fair. Very satisfied!"},
      {name:"Omar R.",city:"Nasr City",car:"BMW M5",stars:5,quote:"Stage 2 tune on my M5 — the difference isn't just in the numbers, it's in how the car feels entirely."}
    ];
    const ins = db.prepare('INSERT INTO testimonials (name, city, car, stars, quote, visible) VALUES (?,?,?,?,?,1)');
    TESTIMONIALS.forEach(t => ins.run(t.name, t.city, t.car, t.stars, t.quote));
  }

  const eventCount = db.prepare('SELECT COUNT(*) c FROM events').get().c;
  if (eventCount === 0) {
    const UPCOMING = [
      {name:"BMW Cairo Track Day 2025",type:"TRACK DAY",badge:"badge-track",date:"2025-03-15",time:"8:00 AM",location:"Cairo International Circuit",price:2500,total:20,remaining:8},
      {name:"MO BMW Night Meet — April",type:"CAR MEET",badge:"badge-meet",date:"2025-04-05",time:"7:00 PM",location:"The Corniche, Heliopolis",price:500,total:50,remaining:23},
      {name:"BMW M Power Drag Night",type:"DRAG NIGHT",badge:"badge-drag",date:"2025-04-20",time:"9:00 PM",location:"Ain Sokhna Drag Strip",price:3000,total:30,remaining:12}
    ];
    const insU = db.prepare('INSERT INTO events (name, event_type, badge_class, event_date, event_time, location, price_egp, total_spots, remaining_spots, is_upcoming, visible, sort_order) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)');
    UPCOMING.forEach((e, i) => insU.run(e.name, e.type, e.badge, e.date, e.time, e.location, e.price, e.total, e.remaining, i));

    const PAST = ["Track Day Feb 2025", "BMW Winter Meet 2024", "Drag Night 2024"];
    const insP = db.prepare('INSERT INTO events (name, is_upcoming, visible, sort_order) VALUES (?, 0, 1, ?)');
    PAST.forEach((name, i) => insP.run(name, i));
  }

  const cfgCount = db.prepare('SELECT COUNT(*) c FROM service_config').get().c;
  if (cfgCount === 0) {
    const cfg = {
      quick_service: {
        price: 850,
        checklist: [
          "Engine oil change (Shell/Castrol OEM)",
          "Oil filter + air filter",
          "Full fluids inspection (coolant, brake fluid, power steering)",
          "Battery and alternator check",
          "Tire pressure adjustment",
          "A/C system check",
          "Scanner fault diagnostics"
        ],
        slots: {SAT:["9:00 AM","11:00 AM"],SUN:["10:00 AM","2:00 PM"],MON:["9:00 AM","4:00 PM"],TUE:["11:00 AM","6:00 PM"],WED:["10:00 AM","2:00 PM"],THU:["9:00 AM","12:00 PM"]}
      },
      full_service: {
        price: 2500,
        checklist: [
          "Everything in Quick Service",
          "Full brake system inspection",
          "Suspension & steering check and adjustment",
          "Gearbox and clutch inspection",
          "Driveshaft and bearings check",
          "Wheel alignment",
          "Electrical system check for hidden faults",
          "Full report with photos and recommendations"
        ],
        slots: {SAT:["9:00 AM","2:00 PM"],MON:["11:00 AM"],WED:["9:00 AM","2:00 PM"],THU:["11:00 AM"]}
      },
      tuning_stages: [
        {stage:'1', stage_label:'STAGE 1', hp_label:"+40–60 HP", price:8500, features:["ECU Remap only","No hardware required","Fully reversible","Full dyno test"], contact_only:false, visible:true},
        {stage:'2', stage_label:'STAGE 2', hp_label:"+80–120 HP", price:32000, features:["Enhanced ECU Remap","Catback Exhaust System","Performance Intake","Dyno test + before/after"], contact_only:false, visible:true},
        {stage:'2+', stage_label:'STAGE 2+', hp_label:"+120–160 HP", price:45000, features:["Stage 2 Remap + Hardware","Upgraded Intercooler","High-Flow Fuel System","Dyno test + before/after"], contact_only:false, visible:true},
        {stage:'custom', stage_label:'CUSTOM TUNING', hp_label:"Custom Build", price:null, features:["Full Engine Build","Turbo Upgrade","Full Suspension & Brakes","Body Modifications + Track Test"], contact_only:true, visible:true}
      ],
      tuning_slots: {SUN:["Full Day"],TUE:["Half Day AM"],THU:["Full Day"]},
      pickup_tiers: [
        {range_label:"Within 15 km", price_egp:250, is_free_threshold:false, threshold_egp:null},
        {range_label:"15–30 km", price_egp:400, is_free_threshold:false, threshold_egp:null},
        {range_label:"Free", price_egp:0, is_free_threshold:true, threshold_egp:3000}
      ],
      pickup_slots: {MON:["10:00 AM","3:00 PM"],WED:["12:00 PM","5:00 PM"],FRI:["10:00 AM"]},
      catalog_series: [
        { id:'1', name:'1 Series', tag:'Compact',      tagColor:'var(--accent-blue)', keywords:['118','120','125','128','M135'] },
        { id:'2', name:'2 Series', tag:'Coupe',        tagColor:'var(--accent-blue)', keywords:['218','220','228','230','M235','M240','M2'] },
        { id:'3', name:'3 Series', tag:'Most Popular', tagColor:'var(--accent-gold)', keywords:['316','318','320','325','328','330','335','340','M3'] },
        { id:'4', name:'4 Series', tag:'Gran Coupe',   tagColor:'var(--accent-cyan)', keywords:['418','420','425','428','430','435','440','M4'] },
        { id:'5', name:'5 Series', tag:'Executive',    tagColor:'var(--accent-cyan)', keywords:['518','520','525','528','530','535','540','M5'] },
        { id:'7', name:'7 Series', tag:'Luxury',       tagColor:'var(--accent-gold)', keywords:['730','740','745','750','760','M760'] },
        { id:'X', name:'X Series', tag:'SUV',          tagColor:'var(--accent-blue)', keywords:['X1','X2','X3','X4','X5','X6','X7'] },
        { id:'M', name:'M Series', tag:'Performance',  tagColor:'#ff3333',            keywords:['M2','M3','M4','M5','M8','M135','M235','M240','M550'] }
      ],
      catalog_engine_map: {
        B48: ['318i','320i','420i','520i','X3 20i','X1 20i','218i','118i'],
        B58: ['330i','340i','430i','440i','530i','540i','X5 40i','X3 30i','M135i','M235i','M240i','230i','Z4 30i'],
        S58: ['M3','M4','M2 CS','M2 Competition'],
        N55: ['335i','435i','535i','X5 35i','X6 35i','M135i (F20)','M235i (F22)'],
        B57: ['320d','330d','520d','530d','X5 30d','X3 20d'],
        S55: ['M3 (F80)','M4 (F82)','M4 GTS'],
        S63: ['M5','M8','M760i','X5 M','X6 M'],
        N63: ['550i','650i','750i','X5 50i','X6 50i'],
        B47: ['316d','318d','418d','518d','X1 18d'],
        S68: ['M60i','XM']
      }
    };
    const ins = db.prepare('INSERT INTO service_config (key, value) VALUES (?, ?)');
    Object.entries(cfg).forEach(([key, value]) => ins.run(key, JSON.stringify(value)));
  }

  const settingsCount = db.prepare('SELECT COUNT(*) c FROM site_settings').get().c;
  if (settingsCount === 0) {
    const settings = {
      phone: '+20 1XX XXX XXXX',
      whatsapp: '201000000000',
      email: 'info@mobybmw.com',
      address: '[Address Placeholder], Cairo, Egypt',
      maps_url: 'https://maps.google.com',
      hours_weekdays: 'Sat–Thu: 9 AM – 8 PM',
      hours_friday: 'Friday: 2 PM – 8 PM',
      social_instagram: '#',
      social_tiktok: '#',
      social_youtube: '#',
      social_facebook: '#',
      stats_clients: '500',
      stats_years: '15',
      stats_cars_modded: '1000',
      site_title: 'MO BY AHMED MAHMOUD',
      tagline: 'Where Precision Meets Performance',
      about_body: 'We started our journey with BMW over 15 years ago, driven by a genuine passion for these exceptional cars. We provide mechanical and electrical maintenance, engine modifications, and professional tuning to deliver maximum performance with reliable parts and top-tier customer service.',
      footer_copyright: '© 2025 MO BY AHMED MAHMOUD | All Rights Reserved',
      privacy_text: 'We respect your privacy. Your personal data is kept secure and is never shared with third parties. The full privacy policy is available upon request.',
      hero_overline: "🏆 Egypt's #1 BMW Tuning Specialist",
      hero_line1: 'MO BY',
      hero_line2: 'AHMED MAHMOUD',
      hero_tagline: 'Where Precision Meets Performance',
      hero_desc: 'Genuine spare parts • Mechanical • Electrical • Professional Tuning',
      hero_car_img: 'https://images.dealer.com/ddc/vehicles/2022/BMW/M4/Coupe/perspective/front-left/2022_24.png',
      hero_cta1_text: 'Book Your Appointment',
      hero_cta1_href: '#services',
      hero_cta2_text: 'Browse Our Services',
      hero_cta2_href: 'spare-parts.html',
      hero_stat1_label: 'Happy Clients', hero_stat1_value: '500+',
      hero_stat2_label: 'Years Experience', hero_stat2_value: '15+',
      hero_stat3_label: 'Cars Modified', hero_stat3_value: '1000+',
      payment_cash_enabled: 'true',
      payment_bank_enabled: 'false',
      payment_wallet_enabled: 'false',
      payment_bank_name: '',
      payment_bank_holder: '',
      payment_bank_account: '',
      payment_wallet_provider: 'Vodafone Cash / InstaPay',
      payment_wallet_number: ''
    };
    const ins = db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
    Object.entries(settings).forEach(([key, value]) => ins.run(key, String(value)));
  }
}

seedIfEmpty();

module.exports = db;
