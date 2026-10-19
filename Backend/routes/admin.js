const express = require("express");
const bcrypt = require("bcryptjs");
const { requireRole } = require("../middleware/roles");

const router = express.Router();

module.exports = (supabase, authenticateToken) => {
  router.use(authenticateToken, requireRole("admin"));

  router.get("/seo-settings", async (req,res) => {
    try {
      const [{data:clients,error:ce},{data:settings,error:se}]=await Promise.all([
        supabase.from("clients").select("id,display_name,client_code,website,status").order("display_name"),
        supabase.from("seo_client_settings").select("*")
      ]);
      if(ce)throw ce;if(se)throw se;
      const byClient=new Map((settings||[]).map(x=>[x.client_id,x]));
      res.json({success:true,clients:(clients||[]).map(c=>({...c,seo:byClient.get(c.id)||{client_id:c.id,enabled:false,site_url:c.website||""}})),configured:{searchConsole:Boolean(process.env.GSC_SERVICE_ACCOUNT_JSON)}});
    } catch(e){console.error("Admin SEO settings:",e.message);res.status(500).json({success:false,message:"Unable to load SEO settings. Run SQL migration 005 first."});}
  });
  router.put("/seo-settings/:clientId", async (req,res) => {
    try {
      const clientId=String(req.params.clientId||"");
      const enabled=Boolean(req.body?.enabled);
      const siteUrl=String(req.body?.siteUrl||"").trim();
      if(siteUrl&&!/^https?:\/\//i.test(siteUrl))return res.status(400).json({success:false,message:"Website URL must start with https:// or http://"});
      const {data:client,error:ce}=await supabase.from("clients").select("id").eq("id",clientId).maybeSingle();if(ce)throw ce;if(!client)return res.status(404).json({success:false,message:"Client not found"});
      const {data,error}=await supabase.from("seo_client_settings").upsert({client_id:clientId,enabled,site_url:siteUrl||null,updated_at:new Date().toISOString()},{onConflict:"client_id"}).select("*").single();
      if(error)throw error;res.json({success:true,setting:data});
    } catch(e){console.error("Save SEO settings:",e.message);res.status(500).json({success:false,message:"Unable to save SEO settings. Confirm SQL migration 005 has been run."});}
  });

  router.get("/overview", async (req, res) => {
    try {
      const [{ data: clients, error: clientsError }, { data: users, error: usersError }] =
        await Promise.all([
          supabase.from("clients").select("id, client_code, company_name, display_name, website, client_type, status, created_at").order("created_at", { ascending: false }),
          supabase.from("users").select("id, client_id, name, email, role, status, created_at").order("created_at", { ascending: false })
        ]);
      if (clientsError) throw clientsError;
      if (usersError) throw usersError;

      const ids=(clients||[]).map(c=>c.id);
      let rows=[];
      if(ids.length){
        const {data,error}=await supabase.from("campaigns").select("client_id,spend,impressions,clicks,leads").in("client_id",ids);
        if(error) throw error;
        rows=data||[];
      }
      const summaries=(clients||[]).map(c=>{
        const r=rows.filter(x=>x.client_id===c.id);
        const sum=k=>r.reduce((n,x)=>n+Number(x[k]||0),0);
        const impressions=sum("impressions"), clicks=sum("clicks");
        return {...c,userCount:(users||[]).filter(u=>u.client_id===c.id).length,spend:sum("spend"),impressions,clicks,leads:sum("leads"),ctr:impressions?Number((clicks/impressions*100).toFixed(2)):null};
      });
      res.json({success:true,clients:summaries,users:users||[]});
    } catch(e){ console.error("Admin overview error:",e?.message||e); res.status(500).json({success:false,message:"Unable to load admin overview"}); }
  });

  router.get("/leads", async (req,res) => {
    try { let q=supabase.from("leads").select("*, clients(display_name,client_code)").order("created_at",{ascending:false}).limit(2000); if(typeof req.query.clientId==="string"&&req.query.clientId)q=q.eq("client_id",req.query.clientId); const {data,error}=await q; if(error)throw error; res.json({success:true,leads:data||[]}); }
    catch(e){console.error("Admin leads error:",e?.message||e);res.status(500).json({success:false,message:"Unable to load agency leads"});}
  });
  router.patch("/leads/:id/status", async (req, res) => {
    try {
      const status = String(req.body?.status || "").toLowerCase();
      if (!["new", "contacted", "qualified", "converted", "lost"].includes(status)) return res.status(400).json({ success: false, message: "Invalid lead status" });
      const { data, error } = await supabase.from("leads").update({ status }).eq("id", req.params.id).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ success: false, message: "Lead not found" });
      res.json({ success: true, lead: data });
    } catch (error) { console.error("Admin update lead status:", error?.message || error); res.status(500).json({ success: false, message: "Unable to update lead status" }); }
  });

  router.get("/social-posts", async (req,res) => {
    try { let q=supabase.from("social_posts").select("*, clients(display_name,client_code)").order("scheduled_at",{ascending:false}).limit(2000); if(typeof req.query.clientId==="string"&&req.query.clientId)q=q.eq("client_id",req.query.clientId); const {data,error}=await q; if(error)throw error; res.json({success:true,posts:data||[]}); }
    catch(e){console.error("Admin social posts error:",e?.message||e);res.status(500).json({success:false,message:"Unable to load social calendar"});}
  });

  router.post("/import", async (req, res) => {
    try {
      const { clientId, dataType, rows } = req.body || {};
      if (!clientId || !["campaigns", "leads"].includes(dataType) || !Array.isArray(rows)) {
        return res.status(400).json({ success:false, message:"clientId, dataType (campaigns or leads), and rows are required" });
      }
      if (rows.length < 1) return res.status(400).json({ success:false, message:"The file contains no data rows" });
      if (rows.length > 1000) return res.status(413).json({ success:false, message:"Import is limited to 1,000 rows per upload" });

      const { data: client, error: clientError } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
      if (clientError) throw clientError;
      if (!client) return res.status(404).json({ success:false, message:"Selected client was not found" });

      const numberOrNull = v => {
        if (v === undefined || v === null || String(v).trim() === "") return null;
        const n = Number(String(v).replace(/[,₹$%]/g, "").trim());
        return Number.isFinite(n) && n >= 0 ? n : NaN;
      };
      const clean = v => v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim();

      if (dataType === "campaigns") {
        const normalized = [];
        for (let i=0; i<rows.length; i++) {
          const r = rows[i] || {};
          const campaignName = clean(r.campaign_name || r.campaignName || r.campaign);
          const platform = (clean(r.platform) || "").toLowerCase();
          if (!campaignName || !["meta", "google", "linkedin", "tiktok", "other"].includes(platform)) {
            return res.status(400).json({success:false,message:`Row ${i+2}: campaign_name and a supported platform (meta, google, linkedin, tiktok, other) are required`});
          }
          const item = { client_id:clientId, campaign_name:campaignName, platform, status:clean(r.status)||"imported" };
          for (const key of ["spend","impressions","clicks","leads","conversions","cpl","roas"]) {
            const value = numberOrNull(r[key]);
            if (Number.isNaN(value)) return res.status(400).json({success:false,message:`Row ${i+2}: ${key} must be a non-negative number`});
            if (value !== null) item[key] = value;
          }
          for (const key of ["date_start","date_stop","currency"]) {
            const value=clean(r[key]); if(value) item[key]=value;
          }
          if (item.date_start && !/^\d{4}-\d{2}-\d{2}$/.test(item.date_start)) return res.status(400).json({success:false,message:`Row ${i+2}: date_start must use YYYY-MM-DD`});
          if (item.date_stop && !/^\d{4}-\d{2}-\d{2}$/.test(item.date_stop)) return res.status(400).json({success:false,message:`Row ${i+2}: date_stop must use YYYY-MM-DD`});
          normalized.push(item);
        }
        const {data:existing,error:existingError}=await supabase.from("campaigns").select("campaign_name,platform,date_start").eq("client_id",clientId);
        if(existingError) throw existingError;
        const keys=new Set((existing||[]).map(x=>[x.platform,String(x.campaign_name||"").toLowerCase(),x.date_start||""].join("|")));
        const fresh=[];
        let skipped=0;
        for(const row of normalized){
          const key=[row.platform,row.campaign_name.toLowerCase(),row.date_start||""].join("|");
          if(keys.has(key)){skipped++;continue;}
          keys.add(key);fresh.push(row);
        }
        if(fresh.length){
          const {error}=await supabase.from("campaigns").insert(fresh);
          if(error) throw error;
        }
        return res.json({success:true,dataType,received:rows.length,imported:fresh.length,skipped, message:"Campaign import completed"});
      }

      const normalized=[];
      for(let i=0;i<rows.length;i++){
        const r=rows[i]||{};
        const name=clean(r.name || r.lead_name || r.leadName);
        const email=clean(r.email)?.toLowerCase()||null;
        const phone=clean(r.phone);
        if(!name || (!email && !phone)) return res.status(400).json({success:false,message:`Row ${i+2}: name and at least email or phone are required`});
        normalized.push({
          client_id:clientId,name,email,phone,
          source:clean(r.source)||"import",
          campaign:clean(r.campaign),
          status:clean(r.status)||"new",
          notes:clean(r.notes)
        });
      }
      const {data:existing,error:existingError}=await supabase.from("leads").select("email,phone").eq("client_id",clientId);
      if(existingError) throw existingError;
      const keys=new Set();
      for(const x of existing||[]){
        if(x.email) keys.add("e:"+x.email.toLowerCase());
        if(x.phone) keys.add("p:"+x.phone.replace(/\s+/g,""));
      }
      const fresh=[]; let skipped=0;
      for(const row of normalized){
        const ek=row.email?"e:"+row.email:null, pk=row.phone?"p:"+row.phone.replace(/\s+/g,""):null;
        if((ek&&keys.has(ek))||(pk&&keys.has(pk))){skipped++;continue;}
        fresh.push(row); if(ek)keys.add(ek); if(pk)keys.add(pk);
      }
      if(fresh.length){
        const {error}=await supabase.from("leads").insert(fresh);
        if(error) throw error;
      }
      return res.json({success:true,dataType,received:rows.length,imported:fresh.length,skipped,message:"Lead import completed"});
    } catch(e) {
      console.error("Admin import error:",e?.code||"",e?.message||e);
      res.status(500).json({success:false,message:"Import failed. Check the file columns and database schema."});
    }
  });

  router.get("/integrations", async (req,res) => {
    try {
      const { data, error } = await supabase
        .from("meta_connections")
        .select("client_id, meta_user_id, ad_account_id, ad_account_name, currency, status, token_expires_at, last_synced_at, last_sync_error, updated_at");
      if (error) throw error;
      res.json({ success: true, integrations: data || [] });
    } catch (e) {
      console.error("Admin integrations error:", e?.message || e);
      res.status(500).json({ success: false, message: "Unable to load integrations" });
    }
  });

  router.post("/clients", async (req,res)=>{
    try{
      const {clientCode,companyName,displayName,website,clientType="standard"}=req.body||{};
      if(!clientCode||!companyName||!displayName) return res.status(400).json({success:false,message:"clientCode, companyName and displayName are required"});
      const {data,error}=await supabase.from("clients").insert({client_code:clientCode.trim(),company_name:companyName.trim(),display_name:displayName.trim(),website:website?.trim()||null,client_type:clientType,status:"active"}).select("id,client_code,company_name,display_name,website,client_type,status,created_at").single();
      if(error) throw error;
      res.status(201).json({success:true,client:data});
    }catch(e){console.error("Admin create client error:",e?.message||e);res.status(500).json({success:false,message:e?.code==="23505"?"Client code already exists":"Unable to create client"});}
  });

  router.patch("/clients/:clientId", async (req,res)=>{
    try{
      const allowed={};
      for(const [key,column] of Object.entries({displayName:"display_name",website:"website",clientType:"client_type",status:"status"})) if(req.body?.[key]!==undefined) allowed[column]=req.body[key];
      if(!Object.keys(allowed).length) return res.status(400).json({success:false,message:"No fields to update"});
      const {data,error}=await supabase.from("clients").update(allowed).eq("id",req.params.clientId).select("id,client_code,company_name,display_name,website,client_type,status,created_at").single();
      if(error) throw error;
      res.json({success:true,client:data});
    }catch(e){console.error("Admin update client error:",e?.message||e);res.status(500).json({success:false,message:"Unable to update client"});}
  });

  router.post("/users", async (req,res)=>{
    try{
      const {clientId,name,email,password}=req.body||{};
      if(!clientId||!name||!email||!password) return res.status(400).json({success:false,message:"clientId, name, email and password are required"});
      if(password.length<8) return res.status(400).json({success:false,message:"Password must be at least 8 characters"});
      const passwordHash=await bcrypt.hash(password,12);
      const {data,error}=await supabase.from("users").insert({client_id:clientId,name:name.trim(),email:email.toLowerCase().trim(),password_hash:passwordHash,role:"client",status:"active"}).select("id,client_id,name,email,role,status,created_at").single();
      if(error) throw error;
      res.status(201).json({success:true,user:data});
    }catch(e){console.error("Admin create user error:",e?.message||e);res.status(500).json({success:false,message:e?.code==="23505"?"Email already exists":"Unable to create user"});}
  });

  router.patch("/users/:userId", async (req,res)=>{
    try{
      const allowed={};
      if(req.body?.name!==undefined) allowed.name=String(req.body.name).trim();
      if(req.body?.status!==undefined) allowed.status=req.body.status;
      if(req.body?.password){
        if(String(req.body.password).length<8) return res.status(400).json({success:false,message:"Password must be at least 8 characters"});
        allowed.password_hash=await bcrypt.hash(String(req.body.password),12);
      }
      if(!Object.keys(allowed).length) return res.status(400).json({success:false,message:"No fields to update"});
      const {data,error}=await supabase.from("users").update(allowed).eq("id",req.params.userId).select("id,client_id,name,email,role,status,created_at").single();
      if(error) throw error;
      res.json({success:true,user:data});
    }catch(e){console.error("Admin update user error:",e?.message||e);res.status(500).json({success:false,message:"Unable to update user"});}
  });


  // Soft-delete a client to preserve campaign and reporting history.
  router.delete("/clients/:clientId", async (req, res) => {
    const clientId = req.params.clientId;
    try {
      const { data: client, error: findError } = await supabase
        .from("clients").select("id, display_name").eq("id", clientId).maybeSingle();
      if (findError) throw findError;
      if (!client) return res.status(404).json({success:false,message:"Client not found"});
      const { error: clientError } = await supabase.from("clients")
        .update({ status: "deleted" }).eq("id", clientId);
      if (clientError) throw clientError;
      const { error: usersError } = await supabase.from("users")
        .update({ status: "inactive" }).eq("client_id", clientId);
      if (usersError) throw usersError;
      res.json({success:true,message:"Client archived and its users deactivated. Historical data was preserved."});
    } catch (e) {
      console.error("Admin delete client error:", e?.message || e);
      res.status(500).json({success:false,message:"Unable to delete client"});
    }
  });

  // Permanently delete a client user; agency admin accounts cannot be deleted here.
  router.delete("/users/:userId", async (req, res) => {
    const userId = req.params.userId;
    try {
      const { data: user, error: findError } = await supabase
        .from("users").select("id, role, email").eq("id", userId).maybeSingle();
      if (findError) throw findError;
      if (!user) return res.status(404).json({success:false,message:"User not found"});
      if (user.role === "admin") return res.status(403).json({success:false,message:"Agency admin accounts cannot be deleted here"});
      const { error } = await supabase.from("users").delete().eq("id", userId);
      if (error) throw error;
      res.json({success:true,message:"User permanently deleted"});
    } catch (e) {
      console.error("Admin delete user error:", e?.message || e);
      res.status(500).json({success:false,message:"Unable to delete user"});
    }
  });

  return router;
};