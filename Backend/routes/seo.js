const express=require("express");
const crypto=require("crypto");
const {requireRole}=require("../middleware/roles");
const router=express.Router();
const b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
let googleTokenCache=null;
async function googleAccessToken(){
 const raw=process.env.GSC_SERVICE_ACCOUNT_JSON;
 if(!raw)throw new Error("Google Search Console is not configured. Add GSC_SERVICE_ACCOUNT_JSON in Hostinger.");
 let account;
 try { account=JSON.parse(raw); }
 catch(parseError) { throw new Error("GSC_SERVICE_ACCOUNT_JSON must contain the entire downloaded service-account JSON object, starting with { and including client_email and private_key. It looks like only a key value was pasted. Update the Hostinger variable with the full JSON file contents."); }
 if(!account.client_email||!account.private_key)throw new Error("GSC_SERVICE_ACCOUNT_JSON is missing client_email or private_key. Paste the entire downloaded service-account JSON file into Hostinger.");
 if(googleTokenCache&&googleTokenCache.exp>Date.now()+60000)return googleTokenCache.token;
 const now=Math.floor(Date.now()/1000),head=b64({alg:"RS256",typ:"JWT"}),claim=b64({iss:account.client_email,scope:"https://www.googleapis.com/auth/webmasters.readonly",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600});
 const unsigned=head+"."+claim;
 const sign=crypto.createSign("RSA-SHA256");sign.update(unsigned);sign.end();
 const assertion=unsigned+"."+sign.sign(account.private_key,"base64url");
 const resp=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
 const data=await resp.json();if(!resp.ok)throw new Error(data.error_description||"Google token exchange failed");
 googleTokenCache={token:data.access_token,exp:Date.now()+Number(data.expires_in||3600)*1000};return data.access_token;
}
async function searchConsole(siteUrl,startDate,endDate){
 const token=await googleAccessToken();
 const endpoint="https://www.googleapis.com/webmasters/v3/sites/"+encodeURIComponent(siteUrl)+"/searchAnalytics/query";
 async function query(dimensions){
  const resp=await fetch(endpoint,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({startDate,endDate,dimensions,rowLimit:100})});
  const data=await resp.json();if(!resp.ok)throw new Error(data.error?.message||"Search Console query failed");return data.rows||[];
 }
 const [queryRows,pageRows]=await Promise.all([query(["query"]),query(["page"])]);
 const clicks=queryRows.reduce((n,r)=>n+Number(r.clicks||0),0),impressions=queryRows.reduce((n,r)=>n+Number(r.impressions||0),0);
 const weightedPosition=impressions?queryRows.reduce((n,r)=>n+Number(r.position||0)*Number(r.impressions||0),0)/impressions:null;
 return {startDate,endDate,clicks,impressions,ctr:impressions?clicks/impressions:0,averagePosition:weightedPosition,queries:queryRows.map(r=>({query:r.keys?.[0]||"",clicks:r.clicks||0,impressions:r.impressions||0,ctr:r.ctr||0,position:r.position||0})),pages:pageRows.map(r=>({page:r.keys?.[0]||"",clicks:r.clicks||0,impressions:r.impressions||0,ctr:r.ctr||0,position:r.position||0}))};
}

module.exports=(supabase,authenticateToken)=>{
 router.get("/status",authenticateToken,async(req,res)=>{
  try{
   const admin=req.user.role==="admin",clientId=admin?String(req.query.clientId||""):String(req.user.clientId||"");
   if(!clientId)return res.status(400).json({success:false,message:"Client ID is required"});
   const {data:setting,error}=await supabase.from("seo_client_settings").select("*").eq("client_id",clientId).maybeSingle();if(error)throw error;
   if(!admin&&!setting?.enabled)return res.status(403).json({success:false,enabled:false,message:"SEO service is not enabled for this client"});
   res.json({success:true,enabled:Boolean(setting?.enabled),siteUrl:setting?.site_url||null,googleConfigured:Boolean(process.env.GSC_SERVICE_ACCOUNT_JSON)});
  }catch(e){console.error("SEO status:",e.message);res.status(500).json({success:false,message:"Unable to load SEO settings"});}
 });
 router.get("/data",authenticateToken,async(req,res)=>{
  try{
   const admin=req.user.role==="admin",clientId=admin?String(req.query.clientId||""):String(req.user.clientId||"");
   if(!clientId)return res.status(400).json({success:false,message:"Client ID is required"});
   const {data:setting,error:se}=await supabase.from("seo_client_settings").select("*").eq("client_id",clientId).maybeSingle();if(se)throw se;
   if(!setting?.enabled)return res.status(403).json({success:false,message:"SEO service is not enabled for this client"});
   const {data:snapshots,error}=await supabase.from("seo_snapshots").select("provider,metric_date,payload,created_at").eq("client_id",clientId).order("metric_date",{ascending:false}).limit(60);if(error)throw error;
   res.json({success:true,siteUrl:setting.site_url,configured:{searchConsole:Boolean(process.env.GSC_SERVICE_ACCOUNT_JSON)},snapshots:snapshots||[]});
  }catch(e){console.error("SEO data:",e.message);res.status(500).json({success:false,message:"Unable to load SEO data"});}
 });
 router.post("/sync",authenticateToken,requireRole("admin"),async(req,res)=>{
  const clientId=String(req.body?.clientId||"");if(!clientId)return res.status(400).json({success:false,message:"Client ID is required"});
  try{
   const {data:setting,error}=await supabase.from("seo_client_settings").select("*").eq("client_id",clientId).maybeSingle();if(error)throw error;
   if(!setting?.enabled)return res.status(400).json({success:false,message:"Enable SEO for this client before syncing"});
   if(!setting.site_url)return res.status(400).json({success:false,message:"Set the client's verified website URL first"});
   const endDate=new Date();endDate.setDate(endDate.getDate()-3);const startDate=new Date(endDate);startDate.setDate(startDate.getDate()-27);
   const date=x=>x.toISOString().slice(0,10),metricDate=date(endDate),results=[];
   if(process.env.GSC_SERVICE_ACCOUNT_JSON){try{const payload=await searchConsole(setting.site_url,date(startDate),metricDate);const {error:e}=await supabase.from("seo_snapshots").upsert({client_id:clientId,provider:"search_console",metric_date:metricDate,payload},{onConflict:"client_id,provider,metric_date"});if(e)throw e;results.push({provider:"search_console",success:true});}catch(e){results.push({provider:"search_console",success:false,message:e.message});}}
   else results.push({provider:"search_console",success:false,message:"GSC_SERVICE_ACCOUNT_JSON is not configured"});
   res.json({success:results.some(r=>r.success),date:metricDate,results});
  }catch(e){console.error("SEO sync:",e.message);res.status(500).json({success:false,message:"SEO sync failed"});}
 });
 return router;
};
