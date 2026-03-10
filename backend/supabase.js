const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL");
}

if (!supabaseKey) {
  throw new Error("Missing SUPABASE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;