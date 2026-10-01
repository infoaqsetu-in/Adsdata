const express = require("express");
const bcrypt = require("bcryptjs");
const { requireRole } = require("../middleware/roles");

const router = express.Router();

module.exports = (supabase, authenticateToken) => {
  router.use(authenticateToken, requireRole("admin"));

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

  return router;
};