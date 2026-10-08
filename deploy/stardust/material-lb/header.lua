-- Public /assets/ and /media/ locations only. Access phase must still reject
-- unknown/raw-malformed targets and unsupported methods before provider choice;
-- known OPTIONS must pass through to the original resolver's no-store preflight.
-- The hash-pinned public inventory is JSON, never executable Lua: a full alias
-- table can exceed LuaJIT's constant limit even when nginx -t succeeds.
-- Exclude inherited add_header Cache-Control (and add_header Vary/CORS managed
-- here) unless the actual target OpenResty has proved its filter order.
local cjson = require "cjson.safe"
local header = ngx.header
header["Cache-Control"] = "no-store"
header["Access-Control-Allow-Origin"] = "*"
header["Access-Control-Allow-Credentials"] = nil

local vary, seen = {}, {}
local old_vary = header["Vary"]
if type(old_vary) ~= "table" then old_vary = { old_vary or "" } end
for _, line in ipairs(old_vary) do
    for token in line:gmatch("[^,]+") do
        token = token:match("^%s*(.-)%s*$")
        local key = token:lower()
        if token ~= "" and not seen[key] then
            seen[key] = true
            vary[#vary + 1] = token
        end
    end
end
if seen["*"] then
    header["Vary"] = "*"
else
    for _, token in ipairs({ "Origin", "Sec-Fetch-Mode" }) do
        if not seen[token:lower()] then vary[#vary + 1] = token end
    end
    header["Vary"] = table.concat(vary, ", ")
end

local function decode(value, plus)
    if value:gsub("%%[%x][%x]", ""):find("%", 1, true) then return nil end
    if plus then value = value:gsub("+", " ") end
    value = value:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
    if value:find("[%z\1-\31\127-\159]") then return nil end
    return value
end
local function path(value)
    if value:lower():find("%%2f") or value:lower():find("%%5c") then return nil end
    return decode(value)
end

local function relative(value)
    if type(value) ~= "string" or #value == 0 or #value > 2048
        or value:sub(1, 1) == "/" or value:sub(-1) == "/" or value:find("//", 1, true) then return false end
    for segment in value:gmatch("[^/]+") do
        if not segment:match("^[A-Za-z0-9_%[%]-][A-Za-z0-9_.%[%]-]*$") or segment:sub(-1) == "." then return false end
    end
    return true
end
local extensions = { png = true, jpg = true, jpeg = true, webp = true, gif = true,
    atlas = true, skel = true, obj = true, mtl = true, json = true,
    mp3 = true, m4a = true, aac = true, ogg = true, oga = true, opus = true, wav = true }
local function public_path(value)
    if type(value) ~= "string" or value:sub(1, 1) ~= "/" or not relative(value:sub(2)) then return false end
    local namespace, suffix = value:match("^/([^/]+)/(.+)$")
    return namespace == "media" or (namespace == "assets" and extensions[suffix:match("[^.]+$")] == true)
end
local function public_object(value)
    if not public_path(value) then return false end
    return value:sub(1, 7) ~= "/media/" or not extensions[value:match("[^./]+$")]
end
local function only_fields(value, fields)
    if type(value) ~= "table" then return false end
    for field in pairs(value) do if not fields[field] then return false end end
    return true
end
local fallback_base = "https://ark-asset.hanabi-ai.cn:25442/releases/v013-hangzhou-20261006-1f742992"
local modelscope_bases = __MATERIAL_LB_MODELSCOPE_BASES__
local openi_only = __MATERIAL_LB_OPENI_ONLY__
local function model_object_path(target)
    if type(target) ~= "string" then return nil end
    for _, base in ipairs(modelscope_bases) do
        if target:sub(1, #base) == base then
            local object = path(target:sub(#base + 1))
            if not object or not public_object("/" .. object) then return nil end
            local encoded = object:gsub("([^A-Za-z0-9_/.-])", function(char)
                return string.format("%%%02X", string.byte(char))
            end)
            if target == base .. encoded then return object end
            return nil
        end
    end
    return nil
end
local oss_path_prefix = __MATERIAL_LB_OSS_PATH_PREFIX__
local mirrors = __MATERIAL_LB_MIRRORS__
local function valid_data(value)
    if not only_fields(value, { fallback_base = true, oss_authority = true, oss_path_prefix = true, entries = true })
        or value.fallback_base ~= fallback_base or value.oss_authority ~= "obs.cn-south-222.ai.pcl.cn"
        or value.oss_path_prefix ~= oss_path_prefix or type(value.entries) ~= "table" then return false end
    for alias in pairs(openi_only) do if value.entries[alias] == nil then return false end end
    local count = 0
    for alias, entry in pairs(value.entries) do
        if not public_path(alias) or not only_fields(entry, { fileName = true, modelscope = true })
            or not relative(entry.fileName) then return false end
        local release, object = entry.fileName:match("^releases/([^/]+)/(.+)$")
        if not mirrors[release] or not public_object("/" .. object)
            or (alias:sub(1, 7) == "/media/" and object:sub(1, 6) ~= "media/") then return false end
        if openi_only[alias] then
            -- An explicitly OpenI-only alias never authorizes any ModelScope redirect.
            if entry.modelscope ~= nil then return false end
        else
            local model_object = model_object_path(entry.modelscope)
            if not model_object or (alias:sub(1, 7) == "/media/" and model_object:sub(1, 6) ~= "media/") then return false end
        end
        count = count + 1
        if count > 50000 then return false end
    end
    return count > 0
end

local method = ngx.req.get_method()
if (method ~= "GET" and method ~= "HEAD") or ngx.status ~= 302 then return end
local key = "__MATERIAL_LB_KEY__"
local data = package.loaded[key]
if data == nil then
    local file = io.open("__MATERIAL_LB_HEADER_DATA__", "rb")
    local raw
    if file then
        raw = file:read("*a")
        file:close()
    end
    data = type(raw) == "string" and cjson.decode(raw) or nil
    -- Cache rejection too: an invalid immutable profile must stay no-store,
    -- not repeatedly read/decode its full inventory on every response.
    if not valid_data(data) then data = false end
    package.loaded[key] = data
end
if type(data) ~= "table" then return end
local raw = ngx.var.request_uri
if type(raw) ~= "string" or #raw > 8192 or raw:find("[%s%z\1-\31\127-\159#]") then return end
local request_path = path(raw:match("^[^?]*"))
local entry = request_path and data.entries[request_path]
if not entry then return end
local location = header["Location"]
if type(location) ~= "string" or #location > 8192 or location:find("[%s%z\1-\31\127-\159#]") then return end
-- This is the stable, public, immutable-revision URL; no CDN auth_key is stored or interpreted.
if entry.modelscope and location == entry.modelscope then
    header["Cache-Control"] = "public, max-age=60"
    return
end
local authority, raw_path, tail = location:match("^https://([^/]+)(/[^?#]*)(.*)$")
if not authority then return end
local destination_path = path(raw_path)
if not destination_path then return end
if tail == "" and "https://" .. authority .. destination_path == data.fallback_base .. request_path then
    header["Cache-Control"] = "public, max-age=60"
    return
end
if authority ~= data.oss_authority and authority ~= data.oss_authority .. ":443" then return end
if destination_path ~= data.oss_path_prefix .. entry.fileName or tail:sub(1, 1) ~= "?" then return end
local query = tail:sub(2)
if query == "" or query:sub(1, 1) == "&" or query:sub(-1) == "&" or query:find("&&", 1, true) then return end
local fields, allowed = {}, { AWSAccessKeyId = true, Expires = true, Signature = true,
    ["response-content-disposition"] = true, sp_request = true }
for pair in query:gmatch("[^&]+") do
    local key, value = pair:match("^([^=]+)=(.*)$")
    if not key then return end
    key, value = decode(key, true), decode(value, true)
    if not key or not value or value == "" or not allowed[key] or fields[key] then return end
    fields[key] = value
end
if fields.sp_request and fields.sp_request ~= "cors" and fields.sp_request ~= "display" then return end
local expires = fields.Expires
if not fields.AWSAccessKeyId or not fields.Signature or not expires or #expires > 13 or not expires:match("^[1-9]%d*$") then return end
local ttl = math.min(60, math.floor(tonumber(expires) - ngx.now() - 30))
if ttl >= 1 then header["Cache-Control"] = "public, max-age=" .. ttl end
