const express=require("express");
const router=express.Router();
module.exports=(supabase,authenticateToken)=>{
 router.get("/",authenticateToken,async(req,res)=>{
  try{
   const admin=req.user.role==="admin";
   const clientId=admin?String(req.query.clientId||""):req.user.clientId;
   let q=supabase.from("social_posts").select("*").order("scheduled_at",{ascending:false}).limit(1000);
   if(!admin)q=q.eq("client_id",clientId); else if(clientId)q=q.eq("client_id",clientId);
   const {data,error}=await q;if(error)throw error;res.json({success:true,posts:data||[]});
  }catch(e){console.error("Social posts error:",e?.message||e);res.status(500).json({success:false,message:"Unable to load social posts"});}
 });
 router.patch("/:id/status",authenticateToken,async(req,res)=>{
  try{
   const status=String(req.body?.status||"");
   if(!["pending_approval","approved","rejected","draft"].includes(status))return res.status(400).json({success:false,message:"Invalid approval status"});
   const isAdmin=req.user.role==="admin";
   const clientId=String(req.user.clientId||"");
   let q=supabase.from("social_posts").update({status,updated_at:new Date().toISOString()}).eq("id",req.params.id);
   if(!isAdmin)q=q.eq("client_id",clientId);
   const {data,error}=await q.select("*").maybeSingle();
   if(error)throw error;
   if(!data)return res.status(404).json({success:false,message:"Post not found or access denied"});
   if(!isAdmin && !["pending_approval","draft"].includes(data.status))return res.status(403).json({success:false,message:"Only draft or pending posts can be submitted"});
   res.json({success:true,post:data});
  }catch(e){console.error("Update social post status error:",e?.message||e);res.status(500).json({success:false,message:"Unable to update post status"});}
 });
 router.post("/",authenticateToken,async(req,res)=>{
  try{
   const clientId=req.user.role==="admin"?req.body?.clientId:req.user.clientId;
   const {caption,platform,scheduledAt,postUrl,mediaUrl,status="draft"}=req.body||{};
   if(!clientId||!caption||!platform)return res.status(400).json({success:false,message:"Client, caption and platform are required"});
   const platforms=["instagram","facebook","linkedin","tiktok","other"],statuses=["draft","pending_approval","approved","scheduled","published","failed","rejected"];
   if(!platforms.includes(String(platform).toLowerCase())||!statuses.includes(status))return res.status(400).json({success:false,message:"Invalid platform or status"});
   const {data:client,error:ce}=await supabase.from("clients").select("id").eq("id",clientId).maybeSingle();if(ce)throw ce;if(!client)return res.status(404).json({success:false,message:"Client not found"});
   const {data,error}=await supabase.from("social_posts").insert({client_id:clientId,caption:String(caption).trim(),platform:String(platform).toLowerCase(),scheduled_at:scheduledAt||null,post_url:postUrl||null,media_url:mediaUrl||null,status}).select("*").single();
   if(error)throw error;res.status(201).json({success:true,post:data});
  }catch(e){console.error("Create social post error:",e?.message||e);res.status(500).json({success:false,message:"Unable to save social post"});}
 });
 return router;
};
