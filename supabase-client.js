import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://eovnjummcqcrgwxkkber.supabase.co";
const SUPABASE_KEY = "sb_publishable_4OpGe5YKit6gpMI42zbHJg_8KDZZXlR";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
