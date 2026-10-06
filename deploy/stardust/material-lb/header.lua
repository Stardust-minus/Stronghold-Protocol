-- Public /assets/ and /media/ locations only. Access phase must still reject
-- unknown/raw-malformed targets and unsupported methods before provider choice;
-- known OPTIONS must pass through to the original resolver's no-store preflight.
-- material_lb_data is a hash-pinned, public manifest module shared with access.
-- Exclude inherited add_header Cache-Control (and add_header Vary/CORS managed
-- here) unless the actual target OpenResty has proved its filter order.
local key = "__MATERIAL_LB_KEY__"
local data = package.loaded[key]
if not data then
    local chunk = assert(loadfile("__MATERIAL_LB_HEADER_DATA__"))
    data = chunk()
    package.loaded[key] = data
end
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

local method = ngx.req.get_method()
if (method ~= "GET" and method ~= "HEAD") or ngx.status ~= 302 then return end
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
