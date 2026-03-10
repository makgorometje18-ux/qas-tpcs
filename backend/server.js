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
const supabase = require("./supabase");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

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
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
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

  return rows;
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

function validateStickerRows(rows) {
  return rows.filter(
    row =>
      !String(row.Order_No || "").trim() ||
      !String(row.Order_Creation_Date || "").trim() ||
      !String(row.Branch_Code || "").trim() ||
      !String(row.Branch_Name || "").trim()
  );
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(title, body) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>${esc(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{font-family:Arial,sans-serif;background:#0f172a;color:white;margin:0;padding:20px}
      .card{max-width:1100px;margin:0 auto;background:rgba(255,255,255,0.08);padding:20px;border-radius:14px}
      a{color:#93c5fd}
      table{width:100%;border-collapse:collapse;background:white;color:#111;border-radius:12px;overflow:hidden}
      th,td{padding:12px;border:1px solid #ddd;text-align:left;font-size:14px}
      th{background:#2563eb;color:white}
      .top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
      .btn{display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;background:#2563eb;color:white}
      .danger{background:#dc2626}
      h1{margin:0 0 10px}
      p{opacity:.9}
    </style>
  </head>
  <body>
    <div class="card">
      ${body}
    </div>
  </body>
  </html>
  `;
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

/* ===== JOBS ===== */
app.get("/jobs", requireLogin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Jobs fetch error:", error);
      return res.status(500).send("Error loading jobs");
    }

    const rows = (data || [])
      .map(
        item => `
        <tr>
          <td>${esc(item.reference_number)}</td>
          <td>${esc(item.order_creation_date)}</td>
          <td>${esc(item.branch_code)}</td>
          <td>${esc(item.branch_name)}</td>
          <td>${esc(item.source)}</td>
          <td>${esc(item.created_at ? new Date(item.created_at).toLocaleString("en-ZA") : "")}</td>
        </tr>
      `
      )
      .join("");

    res.send(
      htmlPage(
        "Jobs",
        `
        <div class="top">
          <h1>Jobs</h1>
          <a class="btn" href="/dashboard">Back to Dashboard</a>
        </div>
        <table>
          <tr>
            <th>Reference Number</th>
            <th>Order Date</th>
            <th>Branch Code</th>
            <th>Branch Name</th>
            <th>Source</th>
            <th>Created At</th>
          </tr>
          ${rows}
        </table>
      `
      )
    );
  } catch (err) {
    console.error("Jobs route error:", err);
    res.status(500).send("Server error loading jobs");
  }
});

/* ===== MANIFEST ===== */
app.get("/manifest", requireLogin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Manifest fetch error:", error);
      return res.status(500).send("Error loading manifest");
    }

    const rows = (data || [])
      .map(
        item => `
        <tr>
          <td>${esc(item.reference_number)}</td>
          <td>${esc(item.branch_code)}</td>
          <td>${esc(item.branch_name)}</td>
          <td>${esc(item.barcode)}</td>
          <td>Economy</td>
        </tr>
      `
      )
      .join("");

    res.send(
      htmlPage(
        "Manifest",
        `
        <div class="top">
          <h1>Collection Manifest</h1>
          <a class="btn" href="/dashboard">Back to Dashboard</a>
        </div>
        <p>Total Shipments: ${esc((data || []).length)}</p>
        <table>
          <tr>
            <th>Reference Number</th>
            <th>Branch Code</th>
            <th>Branch Name</th>
            <th>Barcode</th>
            <th>Service</th>
          </tr>
          ${rows}
        </table>
      `
      )
    );
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

/* ===== DOWNLOAD PLACEHOLDER ===== */
app.get("/download/:filename", requireLogin, (req, res) => {
  res
    .status(501)
    .send("File download is not restored yet on this cloud version.");
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

    res.send(
      htmlPage(
        "POD History",
        `
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
      `
      )
    );
  } catch (err) {
    console.error("POD history route error:", err);
    res.status(500).send("Server error loading POD history");
  }
});

/* ===== POD DELETE ALL ===== */
app.get("/pod-delete", requireLogin, (req, res) => {
  res.status(501).send("Delete all PODs is not enabled in this cloud version.");
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

/* ===== BATCH UPLOAD + STICKER PREVIEW ===== */
app.post("/batch", requireLogin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded.");
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows.length) {
      return res.status(400).send("Excel file contains no data.");
    }

    const requiredColumns = [
      "Order_No",
      "Order_Creation_Date",
      "Branch_Code",
      "Branch_Name"
    ];

    const missingColumns = requiredColumns.filter(
      col => !rows[0]?.hasOwnProperty(col)
    );

    if (missingColumns.length > 0) {
      return res.status(400).send(
        `Missing required columns: ${missingColumns.join(", ")}`
      );
    }

    const invalidRows = validateStickerRows(rows);
    if (invalidRows.length > 0) {
      return res.status(400).send("Some rows have missing required values.");
    }

    const shipmentRecords = buildShipmentRecords(rows, "batch");
    const trackingRecords = buildTrackingRecords(rows);

    const { error: shipmentError } = await supabase
      .from("shipments")
      .insert(shipmentRecords);

    if (shipmentError) {
      console.error("Supabase batch insert error:", shipmentError);
      return res.status(500).send("Error saving batch shipment data");
    }

    const { error: trackingError } = await supabase
      .from("tracking")
      .insert(trackingRecords);

    if (trackingError) {
      console.error("Supabase batch tracking insert error:", trackingError);
      return res.status(500).send("Error saving batch tracking data");
    }

    const stickerHtml = await renderStickerHtml(rows);
    res.send(stickerHtml);
  } catch (err) {
    console.error("Batch route error:", err);
    res.status(500).send("Server error in batch upload");
  }
});

/* ===== MANUAL SAVE + STICKER PREVIEW ===== */
app.post("/manual", requireLogin, async (req, res) => {
  try {
    const rows = buildManualRows(req.body);

    if (!rows.length) {
      return res.status(400).send("No manual rows received.");
    }

    const invalidRows = validateStickerRows(rows);
    if (invalidRows.length > 0) {
      return res.status(400).send("Some manual rows have missing required values.");
    }

    const shipmentRecords = buildShipmentRecords(rows, "manual");
    const trackingRecords = buildTrackingRecords(rows);

    const { error: shipmentError } = await supabase
      .from("shipments")
      .insert(shipmentRecords);

    if (shipmentError) {
      console.error("Supabase insert error:", shipmentError);
      return res.status(500).send("Error saving manual sticker data");
    }

    const { error: trackingError } = await supabase
      .from("tracking")
      .insert(trackingRecords);

    if (trackingError) {
      console.error("Supabase tracking insert error:", trackingError);
      return res.status(500).send("Error saving tracking data");
    }

    const stickerHtml = await renderStickerHtml(rows);
    res.send(stickerHtml);
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