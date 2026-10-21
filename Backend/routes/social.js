const express=require("express");
const router=express.Router();
module.exports=(supabase,authenticateToken)=>{
 router.get("/",authenticateToken,async(req,res)=>{
  try{
   const admin=req.user.role==="admin";
   const clientId=admin?String(req.query.clientId||""):String(req.user.clientId||"");
   if(!admin&&!clientId)return res.status(403).json({success:false,message:"Client account is not linked to a client"});
   let q=supabase.from("social_posts").select("*").order("scheduled_at",{ascending:false}).limit(1000);
   if(clientId)q=q.eq("client_id",clientId);
   const {data,error}=await q;if(error)throw error;
   let posts=data||[];
   if(!admin){
    // Client users may see imported Meta posts only when their Page is explicitly assigned.
    // Keep manually created portal posts (no platform_post_id) visible, but hide legacy
    // imported rows that have no page_id because their source Page cannot be verified.
    const {data:permissions,error:permissionError}=await supabase.from("client_social_page_permissions")
      .select("page_id").eq("client_id",clientId).eq("is_allowed",true);
    if(permissionError)throw permissionError;
    const allowedPageIds=new Set((permissions||[]).map(x=>String(x.page_id)));
    posts=posts.filter(p=>{
      if(p.platform_post_id)return Boolean(p.page_id)&&allowedPageIds.has(String(p.page_id));
      return !p.page_id||allowedPageIds.has(String(p.page_id));
    });
   }
   res.json({success:true,posts});
  }catch(e){console.error("Social posts error:",e?.message||e);res.status(500).json({success:false,message:"Unable to load social posts"});}
 });
 router.patch("/:id/status",authenticateToken,async(req,res)=>{
  try{
   const status=String(req.body?.status||"");
   if(!["pending_approval","approved","rejected","draft","scheduled","published","failed"].includes(status))return res.status(400).json({success:false,message:"Invalid post status"});
   const isAdmin=req.user.role==="admin";
   const clientId=String(req.user.clientId||"");
   let lookup=supabase.from("social_posts").select("*").eq("id",req.params.id);
   if(!isAdmin)lookup=lookup.eq("client_id",clientId);
   const {data:existing,error:lookupError}=await lookup.maybeSingle();
   if(lookupError)throw lookupError;
   if(!existing)return res.status(404).json({success:false,message:"Post not found or access denied"});
   if(!isAdmin && !(existing.status==="pending_approval" && ["approved","rejected"].includes(status) || ["draft","pending_approval"].includes(existing.status) && status==="pending_approval"))return res.status(403).json({success:false,message:"You can only approve or reject posts awaiting your review"});
   const {data,error}=await supabase.from("social_posts").update({status,updated_at:new Date().toISOString()}).eq("id",req.params.id).select("*").maybeSingle();
   if(error)throw error;
   if(!data)return res.status(404).json({success:false,message:"Post not found or access denied"});
   res.json({success:true,post:data});
  }catch(e){console.error("Update social post status error:",e?.message||e);res.status(500).json({success:false,message:"Unable to update post status"});}
 });
 router.post("/",authenticateToken,async(req,res)=>{
  try{
   const clientId=req.user.role==="admin"?req.body?.clientId:req.user.clientId;
   const {caption,platform,scheduledAt,postUrl,mediaUrl,status="draft"}=req.body||{};
   if(!clientId||!caption||!platform)return res.status(400).json({success:false,message:"Client, caption and platform are required"});
   if(req.user.role!=="admin" && !["draft","pending_approval"].includes(status))return res.status(403).json({success:false,message:"Client users can only create draft or pending-approval posts"});
   const platforms=["instagram","facebook","linkedin","tiktok","other"],statuses=["draft","pending_approval","approved","scheduled","published","failed","rejected"];
   if(!platforms.includes(String(platform).toLowerCase())||!statuses.includes(status))return res.status(400).json({success:false,message:"Invalid platform or status"});
   const {data:client,error:ce}=await supabase.from("clients").select("id").eq("id",clientId).maybeSingle();if(ce)throw ce;if(!client)return res.status(404).json({success:false,message:"Client not found"});
   const {data,error}=await supabase.from("social_posts").insert({client_id:clientId,caption:String(caption).trim(),platform:String(platform).toLowerCase(),scheduled_at:scheduledAt||null,post_url:postUrl||null,media_url:mediaUrl||null,status}).select("*").single();
   if(error)throw error;res.status(201).json({success:true,post:data});
  }catch(e){console.error("Create social post error:",e?.message||e);res.status(500).json({success:false,message:"Unable to save social post"});}
 });
 return router;
};
