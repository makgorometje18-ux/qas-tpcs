if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const xlsx = require("xlsx");
const bwipjs = require("bwip-js");
const puppeteer = require("puppeteer");
const supabase = require("./supabase");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const OUTPUT_DIR = path.join(__dirname, "../output");
const LOGS_DIR = path.join(__dirname, "../logs");
const CURRENT_MANIFEST_PATH = path.join(LOGS_DIR, "current-manifest.json");

ensureDir(OUTPUT_DIR);
ensureDir(LOGS_DIR);

/* ===== BASIC MIDDLEWARE ===== */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

/* ===== SESSION ===== */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: true
  })
);

/* ===== LOGIN PROTECTION ===== */
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

/* ===== HELPERS ===== */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildManualRows(body) {
  const orderNos = toArray(body.Order_No);
  const orderDates = toArray(body.Order_Creation_Date);
  const branchCodes = toArray(body.Branch_Code);
  const branchNames = toArray(body.Branch_Name);

  const maxLen = Math.max(
    orderNos.length,
    orderDates.length,
    branchCodes.length,
    branchNames.length
  );

  const rows = [];

  for (let i = 0; i < maxLen; i++) {
    rows.push({
      Order_No: String(orderNos[i] || "").trim(),
      Order_Creation_Date: String(orderDates[i] || "").trim(),
      Branch_Code: String(branchCodes[i] || "").trim(),
      Branch_Name: String(branchNames[i] || "").trim()
    });
  }

  return rows.filter(
    row =>
      row.Order_No ||
      row.Order_Creation_Date ||
      row.Branch_Code ||
      row.Branch_Name
  );
}

function validateStickerRows(rows) {
  return rows.filter(
    row =>
      !String(row.Order_No || "").trim() ||
      !String(row.Order_Creation_Date || "").trim() ||
      !String(row.Branch_Code || "").trim() ||
      !String(row.Branch_Name || "").trim()
  );
}

function buildShipmentRecords(rows, source) {
  return rows.map(row => ({
    reference_number: String(row.Order_No || "").trim(),
    order_creation_date: String(row.Order_Creation_Date || "").trim(),
    branch_code: String(row.Branch_Code || "").trim(),
    branch_name: String(row.Branch_Name || "").trim(),
    barcode: String(row.Order_No || "").trim(),
    source
  }));
}

function buildTrackingRecords(rows, status = "Created", location = "QAS-TPCS") {
  return rows.map(row => ({
    reference_number: String(row.Order_No || "").trim(),
    status,
    location
  }));
}

function buildManifestRows(rows) {
  return rows.map(row => ({
    barcode: String(row.Order_No || "").trim(),
    Branch_Code: String(row.Branch_Code || "").trim(),
    branch: String(row.Branch_Name || "").trim(),
    parcels: 1
  }));
}

function saveCurrentManifest(rows) {
  fs.writeFileSync(CURRENT_MANIFEST_PATH, JSON.stringify(rows, null, 2), "utf8");
}

async function saveToSupabase(rows, source) {
  const shipmentRecords = buildShipmentRecords(rows, source);
  const trackingRecords = buildTrackingRecords(rows);

  const { error: shipmentError } = await supabase
    .from("shipments")
    .insert(shipmentRecords);

  if (shipmentError) {
    throw new Error(`Supabase shipment save failed: ${shipmentError.message}`);
  }

  const { error: trackingError } = await supabase
    .from("tracking")
    .insert(trackingRecords);

  if (trackingError) {
    throw new Error(`Supabase tracking save failed: ${trackingError.message}`);
  }
}

async function renderStickerHtml(rows) {
  let template = fs.readFileSync(
    path.join(__dirname, "../templates/sticker.html"),
    "utf8"
  );

  let stickersHtml = "";

  for (const row of rows) {
    const barcodeValue = String(row.Order_No || "").trim();

    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: "code128",
      text: barcodeValue,
      scale: 3,
      height: 10,
      includetext: false
    });

    const barcodeBase64 = barcodeBuffer.toString("base64");

    stickersHtml += `
      <div class="sticker">
        <div class="label">Capitec Reference Number</div>
        <div class="value">${esc(row.Order_No)}</div>

        <div class="label">Order Creation Date</div>
        <div class="value">${esc(row.Order_Creation_Date)}</div>

        <div class="label">Branch Code</div>
        <div class="value">${esc(row.Branch_Code)}</div>

        <div class="label">Branch Name</div>
        <div class="value">${esc(row.Branch_Name)}</div>

        <div class="barcode-label">Barcode</div>
        <div class="barcode-area">
          <img src="data:image/png;base64,${barcodeBase64}">
          <div class="barcode-text">${esc(row.Order_No)}</div>
        </div>
      </div>
    `;
  }

  template = template.replace("{{STICKERS}}", stickersHtml);
  return template;
}

async function generateStickerPdfLocal(rows, prefix) {
  const stickerHtml = await renderStickerHtml(rows);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pdfFilename = `${prefix}_${timestamp}.pdf`;
  const pdfPath = path.join(OUTPUT_DIR, pdfFilename);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(stickerHtml, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      width: "210mm",
      height: "298.4mm",
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "0mm",
        left: "0mm"
      }
    });
  } finally {
    await browser.close();
  }

  return { pdfFilename, stickerHtml };
}

function renderSuccessPageLocal({ title, downloadUrl, manifestUrl }) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>${esc(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{
        margin:0;
        font-family:Arial, Helvetica, sans-serif;
        background:#f4f4f4;
        color:#111;
        text-align:center;
      }
      .wrap{
        max-width:900px;
        margin:0 auto;
        padding:80px 20px;
      }
      h1{
        font-size:54px;
        margin-bottom:25px;
      }
      .bar-wrap{
        max-width:1020px;
        margin:40px auto 0;
        background:#d9d9d9;
        border-radius:18px;
        height:36px;
        overflow:hidden;
      }
      .bar{
        width:100%;
        height:100%;
        background:#3c94d1;
      }
      .percent{
        font-size:34px;
        margin-top:55px;
      }
      .tick{
        font-size:110px;
        color:green;
        line-height:1;
        margin-top:35px;
      }
      .success{
        font-size:42px;
        font-weight:bold;
        margin-top:18px;
      }
      .sub{
        font-size:26px;
        margin-top:25px;
      }
      iframe{display:none;}
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Generating Stickers...</h1>

      <div class="bar-wrap">
        <div class="bar"></div>
      </div>

      <div class="percent">100%</div>
      <div class="tick">✓</div>
      <div class="success">Stickers Generated Successfully</div>
      <div class="sub">Opening manifest...</div>
    </div>

    <iframe id="downloadFrame"></iframe>

    <script>
      window.onload = function () {
        document.getElementById("downloadFrame").src = ${JSON.stringify(downloadUrl)};
        setTimeout(function () {
          window.location.href = ${JSON.stringify(manifestUrl)};
        }, 1800);
      };
    </script>
  </body>
  </html>
  `;
}

function renderSuccessPageVercel({ title, previewUrl, manifestUrl }) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>${esc(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{
        margin:0;
        font-family:Arial, Helvetica, sans-serif;
        background:#f4f4f4;
        color:#111;
        text-align:center;
      }
      .wrap{
        max-width:900px;
        margin:0 auto;
        padding:80px 20px;
      }
      h1{
        font-size:54px;
        margin-bottom:25px;
      }
      .bar-wrap{
        max-width:1020px;
        margin:40px auto 0;
        background:#d9d9d9;
        border-radius:18px;
        height:36px;
        overflow:hidden;
      }
      .bar{
        width:100%;
        height:100%;
        background:#3c94d1;
      }
      .percent{
        font-size:34px;
        margin-top:55px;
      }
      .tick{
        font-size:110px;
        color:green;
        line-height:1;
        margin-top:35px;
      }
      .success{
        font-size:42px;
        font-weight:bold;
        margin-top:18px;
      }
      .sub{
        font-size:26px;
        margin-top:25px;
      }
      .btn{
        display:inline-block;
        margin-top:25px;
        padding:14px 22px;
        border-radius:10px;
        text-decoration:none;
        background:#2563eb;
        color:white;
        font-size:18px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Generating Stickers...</h1>

      <div class="bar-wrap">
        <div class="bar"></div>
      </div>

      <div class="percent">100%</div>
      <div class="tick">✓</div>
      <div class="success">Stickers Generated Successfully</div>
      <div class="sub">Opening sticker print view...</div>

      <a class="btn" href="${esc(previewUrl)}" target="_blank">Open Sticker Print View</a>
    </div>

    <script>
      window.onload = function () {
        window.open(${JSON.stringify(previewUrl)}, "_blank");
        setTimeout(function () {
          window.location.href = ${JSON.stringify(manifestUrl)};
        }, 1800);
      };
    </script>
  </body>
  </html>
  `;
}

function renderManifestPage(rows) {
  const today = new Date().toLocaleDateString("en-ZA");
  const manifestNumber = "MN-" + Date.now();

  const rowHtml = rows.map(r => `
    <tr>
      <td>${esc(r.barcode)}</td>
      <td>${esc(r.Branch_Code)}</td>
      <td>${esc(r.branch)}</td>
      <td>${esc(r.parcels)}</td>
      <td>Economy</td>
    </tr>
  `).join("");

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Collection Manifest</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{
        margin:0;
        padding:0;
        font-family:Arial, Helvetica, sans-serif;
        background:linear-gradient(90deg,#07153f,#05122e);
        color:white;
      }
      .page{
        padding:28px 34px 40px;
      }
      .topbar{
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:44px;
      }
      .btn{
        display:inline-block;
        padding:16px 28px;
        border-radius:28px;
        text-decoration:none;
        color:white;
        font-size:20px;
      }
      .btn-back{background:#7c8597;}
      .btn-toggle{background:#3b82f6;}
      .header{
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        margin-top:10px;
        margin-bottom:10px;
      }
      .brand{
        font-size:38px;
        font-weight:700;
      }
      .manifest-no{
        font-size:24px;
        font-weight:700;
      }
      .title{
        text-align:center;
        font-size:42px;
        font-weight:800;
        margin:8px 0 18px;
      }
      .info-grid{
        display:grid;
        grid-template-columns: 1.6fr 1fr;
        border:1px solid #111827;
        margin-bottom:32px;
      }
      .info-cell{
        border:1px solid #111827;
        background:#1d2b47;
        padding:0;
      }
      .label{
        font-size:18px;
        font-weight:700;
        padding:8px 10px 4px;
      }
      .value{
        background:#ffffff;
        color:#111;
        margin:0 10px 10px;
        padding:12px 14px;
        border-radius:8px;
        font-size:18px;
      }
      .value-dark{
        background:transparent;
        color:white;
        margin:4px 10px 10px;
        padding:0;
        font-size:18px;
      }
      h3{
        margin:18px 0 14px;
        font-size:22px;
        font-weight:800;
      }
      table{
        width:100%;
        border-collapse:collapse;
        margin-bottom:22px;
      }
      th{
        background:#3b82f6;
        color:white;
        border:1px solid #111827;
        padding:14px 10px;
        font-size:18px;
      }
      td{
        background:#1d2b47;
        color:white;
        border:1px solid #111827;
        padding:14px 10px;
        font-size:17px;
        text-align:center;
      }
      .terms{
        background:white;
        color:black;
        padding:14px;
        border:2px solid #111;
        font-size:13px;
        line-height:1.5;
      }
      @media print{
        .topbar{display:none;}
        body{background:white;color:black;}
        .page{padding:20px;}
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="topbar">
        <a href="/dashboard" class="btn btn-back">← Dashboard</a>
        <div></div>
        <div class="btn btn-toggle">🌓 Toggle</div>
      </div>

      <div class="header">
        <div class="brand">QAS-TPCS</div>
        <div class="manifest-no">Manifest No: ${esc(manifestNumber)}</div>
      </div>

      <div class="title">COLLECTION MANIFEST</div>

      <div class="info-grid">
        <div class="info-cell">
          <div class="label">Collection Date: ${esc(today)}</div>
          <div class="label">Collection Address:</div>
          <div class="value">19 London Circle, Bracken Gate 1 Business Park, Brackenfell</div>
        </div>
        <div class="info-cell">
          <div class="label">Total Shipments: ${esc(rows.length)}</div>
          <div class="label" style="margin-top:28px;">Created By: <span class="value-dark">QAS-TPCS System</span></div>
        </div>
      </div>

      <h3>SHIPMENT DETAILS</h3>

      <table>
        <tr>
          <th>Barcode Number</th>
          <th>Branch Code</th>
          <th>Branch Name</th>
          <th>Number of Parcels</th>
          <th>Service</th>
        </tr>
        ${rowHtml}
      </table>

      <div class="terms">
        <b>TERMS AND CONDITIONS</b><br><br>
        I, the undersigned, hereby acknowledge receipt of this sealed package and confirm that it shows no visible signs of tampering at the time of collection. I accept full responsibility for the safekeeping and proper use of the package in accordance with all applicable terms and conditions.<br><br>
        I further agree that IDEMIA shall not be held liable for any loss, damage, or interception of personal documents contained within the package, nor for any consequences arising therefrom. By signing, I indemnify and hold IDEMIA harmless against any such loss, damage, or consequence.
      </div>
    </div>
  </body>
  </html>
  `;
}

function renderPrintPreviewPage(stickerHtml) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Sticker Print Preview</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{margin:0;background:#e5e7eb}
      .top{
        position:sticky;
        top:0;
        background:#0f172a;
        color:white;
        padding:12px 16px;
        display:flex;
        justify-content:space-between;
        align-items:center;
        z-index:10;
      }
      .btn{
        display:inline-block;
        padding:10px 14px;
        border-radius:10px;
        text-decoration:none;
        background:#2563eb;
        color:white;
        border:none;
        cursor:pointer;
        font-size:16px;
      }
      .paper{
        background:white;
        width:210mm;
        min-height:298.4mm;
        margin:20px auto;
        box-shadow:0 10px 30px rgba(0,0,0,0.15);
      }
      @media print{
        .top{display:none}
        body{background:white}
        .paper{
          margin:0;
          box-shadow:none;
        }
      }
    </style>
  </head>
  <body>
    <div class="top">
      <div>Sticker Print Preview</div>
      <button class="btn" onclick="window.print()">Print</button>
    </div>
    <div class="paper">
      ${stickerHtml}
    </div>
    <script>
      window.onload = function () {
        setTimeout(function () {
          window.print();
        }, 400);
      };
    </script>
  </body>
  </html>
  `;
}

async function handleStickerGeneration(req, res, rows, source, prefix) {
  const invalidRows = validateStickerRows(rows);
  if (invalidRows.length > 0) {
    return res.status(400).send("Some rows have missing required values.");
  }

  await saveToSupabase(rows, source);

  const manifestRows = buildManifestRows(rows);
  saveCurrentManifest(manifestRows);

  if (IS_PRODUCTION) {
    const stickerHtml = await renderStickerHtml(rows);
    req.session.lastStickerHtml = stickerHtml;

    return res.send(
      renderSuccessPageVercel({
        title: "Generating Stickers",
        previewUrl: "/print-preview",
        manifestUrl: "/jobs"
      })
    );
  }

  const { pdfFilename } = await generateStickerPdfLocal(rows, prefix);

  return res.send(
    renderSuccessPageLocal({
      title: "Generating Stickers",
      downloadUrl: `/download/${pdfFilename}`,
      manifestUrl: "/jobs"
    })
  );
}

/* ===== PRINT PREVIEW ===== */
app.get("/print-preview", requireLogin, (req, res) => {
  const stickerHtml = req.session.lastStickerHtml;

  if (!stickerHtml) {
    return res.send("No sticker preview available. Generate stickers first.");
  }

  res.send(renderPrintPreviewPage(stickerHtml));
});

/* ===== HOME ===== */
app.get("/", (req, res) => {
  res.send(`
    <h1>QAS-TPCS Server Running</h1>
    <p>If you see this page, your server is working correctly.</p>
    <p><a href="/login">Go to Login</a></p>
  `);
});

/* ===== LOGIN PAGE ===== */
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

/* ===== LOGIN POST ===== */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username)
      .eq("password", password)
      .single();

    if (error || !data) {
      return res.send("Invalid login");
    }

    req.session.user = {
      username: data.username,
      role: data.role
    };

    return res.redirect("/dashboard");
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).send("Server error during login");
  }
});

/* ===== LOGOUT ===== */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/* ===== DASHBOARD ===== */
app.get("/dashboard", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;

    const { data: shipments, error: shipmentsError } = await supabase
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });

    const { data: pods, error: podsError } = await supabase
      .from("pods")
      .select("*");

    if (shipmentsError || podsError) {
      console.error("Dashboard query error:", shipmentsError || podsError);
      return res.status(500).send("Error loading dashboard data");
    }

    const stickerCount = shipments ? shipments.length : 0;
    const podCount = pods ? pods.length : 0;

    let rows = "";
    (shipments || []).slice(0, 10).forEach(item => {
      const date = item.created_at
        ? new Date(item.created_at).toLocaleDateString("en-ZA")
        : "";

      rows += `
        <tr>
          <td>${esc(item.source || "shipment")}</td>
          <td>${esc(item.reference_number || item.barcode || "")}</td>
          <td>${esc(date)}</td>
        </tr>
      `;
    });

    let html = fs.readFileSync(
      path.join(__dirname, "../frontend/dashboard.html"),
      "utf8"
    );

    html = html
      .replace("{{USER}}", esc(user.username))
      .replace("{{ROLE}}", esc(user.role))
      .replace("{{STICKERS}}", String(stickerCount))
      .replace("{{PODS}}", String(podCount))
      .replace("{{ROWS}}", rows);

    html = html.replace("{{ADMIN}}", "");

    res.send(html);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Server error loading dashboard");
  }
});

/* ===== PAGE ROUTES ===== */
app.get("/manual", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/manual.html"));
});

app.get("/batch", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/batch.html"));
});

app.get("/tracking", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/tracking.html"));
});

app.get("/chat", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/chat.html"));
});

app.get("/chat-service", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/chat-service.html"));
});

app.get("/chat-tracking", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/chat-tracking.html"));
});

/* ===== JOBS / CURRENT MANIFEST ===== */
app.get("/jobs", requireLogin, (req, res) => {
  try {
    if (!fs.existsSync(CURRENT_MANIFEST_PATH)) {
      return res.send("No manifest yet. Generate stickers first.");
    }

    const manifestRows = JSON.parse(fs.readFileSync(CURRENT_MANIFEST_PATH, "utf8"));
    res.send(renderManifestPage(manifestRows));
  } catch (err) {
    console.error("Jobs route error:", err);
    res.status(500).send("Server error loading jobs");
  }
});

/* ===== MANIFEST ===== */
app.get("/manifest", requireLogin, (req, res) => {
  try {
    if (!fs.existsSync(CURRENT_MANIFEST_PATH)) {
      return res.send("No manifest yet. Generate stickers first.");
    }

    const manifestRows = JSON.parse(fs.readFileSync(CURRENT_MANIFEST_PATH, "utf8"));
    res.send(renderManifestPage(manifestRows));
  } catch (err) {
    console.error("Manifest route error:", err);
    res.status(500).send("Server error loading manifest");
  }
});

/* ===== MANIFEST SIGN / CREATE POD ===== */
app.post("/manifest-sign", requireLogin, async (req, res) => {
  try {
    const {
      driverName,
      dispatchName,
      reference_numbers,
      podNumber
    } = req.body;

    const finalPodNumber =
      String(podNumber || "").trim() || `POD-${Date.now().toString().slice(-6)}`;

    const { error: podError } = await supabase
      .from("pods")
      .insert([
        {
          pod_number: finalPodNumber,
          driver_name: String(driverName || "").trim(),
          dispatch_name: String(dispatchName || "").trim()
        }
      ]);

    if (podError) {
      console.error("POD insert error:", podError);
      return res.status(500).send("Error saving POD");
    }

    const refs = toArray(reference_numbers)
      .flatMap(v => String(v || "").split(","))
      .map(v => v.trim())
      .filter(Boolean);

    if (refs.length > 0) {
      const trackingRows = refs.map(ref => ({
        reference_number: ref,
        status: "Collected",
        location: "Dispatch"
      }));

      const { error: trackingError } = await supabase
        .from("tracking")
        .insert(trackingRows);

      if (trackingError) {
        console.error("Manifest tracking error:", trackingError);
      }
    }

    res.send(`POD saved successfully: ${finalPodNumber}`);
  } catch (err) {
    console.error("Manifest sign error:", err);
    res.status(500).send("Server error saving POD");
  }
});

/* ===== DOWNLOAD PDF ===== */
app.get("/download/:filename", requireLogin, (req, res) => {
  try {
    const filePath = path.join(OUTPUT_DIR, req.params.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("File not found.");
    }

    res.download(filePath);
  } catch (err) {
    console.error("Download route error:", err);
    res.status(500).send("Server error downloading file");
  }
});

/* ===== POD HISTORY ===== */
app.get("/pod-history", requireLogin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pods")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("POD history fetch error:", error);
      return res.status(500).send("Error loading POD history");
    }

    const isAdmin = req.session.user?.role === "admin";

    const rows = (data || [])
      .map(
        item => `
        <tr>
          <td>${esc(item.pod_number)}</td>
          <td>${esc(item.driver_name)}</td>
          <td>${esc(item.dispatch_name)}</td>
          <td>${esc(item.created_at ? new Date(item.created_at).toLocaleString("en-ZA") : "")}</td>
          <td>
            ${
              isAdmin
                ? `<a class="btn danger" href="/pod-delete/${encodeURIComponent(item.pod_number)}" onclick="return confirm('Delete this POD?')">Delete</a>`
                : ""
            }
          </td>
        </tr>
      `
      )
      .join("");

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>POD History</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body{font-family:Arial;background:#0f172a;color:white;margin:0;padding:20px}
          .card{max-width:1100px;margin:auto;background:rgba(255,255,255,0.08);padding:20px;border-radius:14px}
          .top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
          .btn{display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;background:#2563eb;color:white}
          .danger{background:#dc2626}
          table{width:100%;border-collapse:collapse;background:white;color:#111}
          th,td{padding:12px;border:1px solid #ddd}
          th{background:#2563eb;color:white}
        </style>
      </head>
      <body>
        <div class="card">
          <div class="top">
            <h1>POD History</h1>
            <a class="btn" href="/dashboard">Back to Dashboard</a>
          </div>
          <table>
            <tr>
              <th>POD Number</th>
              <th>Driver Name</th>
              <th>Dispatch Name</th>
              <th>Created At</th>
              <th>Action</th>
            </tr>
            ${rows}
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("POD history route error:", err);
    res.status(500).send("Server error loading POD history");
  }
});

/* ===== POD DELETE ALL ===== */
app.get("/pod-delete", requireLogin, (req, res) => {
  res.status(501).send("Delete all PODs is not enabled.");
});

/* ===== POD DELETE ONE ===== */
app.get("/pod-delete/:podNo", requireLogin, async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.send("Access denied. Admin only.");
    }

    const podNo = req.params.podNo;

    const { error } = await supabase
      .from("pods")
      .delete()
      .eq("pod_number", podNo);

    if (error) {
      console.error("POD delete error:", error);
      return res.status(500).send("Error deleting POD");
    }

    res.redirect("/pod-history");
  } catch (err) {
    console.error("POD delete route error:", err);
    res.status(500).send("Server error deleting POD");
  }
});

/* ===== BATCH ===== */
app.post("/batch", requireLogin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded.");
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = xlsx.utils.sheet_to_json(sheet);

    if (!rawRows.length) {
      return res.status(400).send("Excel file contains no data.");
    }

    const requiredColumns = [
      "Order_No",
      "Order_Creation_Date",
      "Branch_Code",
      "Branch_Name"
    ];

    const missingColumns = requiredColumns.filter(
      col => !rawRows[0]?.hasOwnProperty(col)
    );

    if (missingColumns.length > 0) {
      return res.status(400).send(
        `Missing required columns: ${missingColumns.join(", ")}`
      );
    }

    const rows = rawRows.map(row => ({
      Order_No: String(row.Order_No || "").trim(),
      Order_Creation_Date: String(row.Order_Creation_Date || "").trim(),
      Branch_Code: String(row.Branch_Code || "").trim(),
      Branch_Name: String(row.Branch_Name || "").trim()
    }));

    return await handleStickerGeneration(req, res, rows, "batch", "QAS-TPCS_Batch");
  } catch (err) {
    console.error("Batch route error:", err);
    res.status(500).send("Server error in batch upload");
  }
});

/* ===== MANUAL ===== */
app.post("/manual", requireLogin, async (req, res) => {
  try {
    const rows = buildManualRows(req.body);

    if (!rows.length) {
      return res.status(400).send("No manual rows received.");
    }

    return await handleStickerGeneration(req, res, rows, "manual", "QAS-TPCS_Manual");
  } catch (err) {
    console.error("Manual route error:", err);
    res.status(500).send("Server error in manual generation");
  }
});

/* ===== TRACK LOOKUP ===== */
app.get("/track/:code", async (req, res) => {
  try {
    const code = req.params.code.trim();

    const { data, error } = await supabase
      .from("tracking")
      .select("*")
      .eq("reference_number", code)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Tracking fetch error:", error);
      return res.status(500).json([]);
    }

    res.json(data || []);
  } catch (err) {
    console.error("Track route error:", err);
    res.status(500).json([]);
  }
});

/* ===== TEST DB ===== */
app.get("/test-db", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*");

    if (error) {
      console.error("Supabase query error:", error);
      return res.status(500).json({
        source: "supabase",
        message: error.message,
        details: error.details || null,
        hint: error.hint || null,
        code: error.code || null
      });
    }

    return res.json(data);
  } catch (err) {
    console.error("Server crash in /test-db:", err);
    return res.status(500).json({
      source: "server",
      message: err.message
    });
  }
});

module.exports = app;