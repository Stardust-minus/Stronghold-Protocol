local cjson = require "cjson.safe"
local key = "ark_material_lb_20261006_model60_v3"
local modelscope_bases = __MATERIAL_LB_MODELSCOPE_BASES__
local openi_only = __MATERIAL_LB_OPENI_ONLY__
local extensions = { png = true, jpg = true, jpeg = true, webp = true, gif = true,
    atlas = true, skel = true, obj = true, mtl = true, json = true,
    mp3 = true, m4a = true, aac = true, ogg = true, oga = true, opus = true, wav = true }
local function public_path(value)
    if type(value) ~= "string" or value:sub(1, 1) ~= "/" or #value < 2 or #value > 2049
        or value:sub(-1) == "/" or value:find("//", 1, true) then return false end
    for segment in value:gmatch("[^/]+") do
        if not segment:match("^[A-Za-z0-9_%[%]-][A-Za-z0-9_.%[%]-]*$") or segment:sub(-1) == "." then return false end
    end
    local namespace, suffix = value:match("^/([^/]+)/(.+)$")
    return namespace == "media" or (namespace == "assets" and extensions[suffix:match("[^.]+$")] == true)
end
local function model_target_allowed(target)
    if type(target) ~= "string" then return false end
    for _, base in ipairs(modelscope_bases) do
        if target:sub(1, #base) == base then
            local raw = target:sub(#base + 1)
            if raw:lower():find("%%2f") or raw:lower():find("%%5c")
                or raw:gsub("%%[%x][%x]", ""):find("%", 1, true) then return false end
            local object = raw:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
            if not public_path("/" .. object)
                or (object:sub(1, 6) == "media/" and extensions[object:match("[^./]+$")]) then return false end
            local encoded = object:gsub("([^A-Za-z0-9_/.-])", function(char)
                return string.format("%%%02X", string.byte(char))
            end)
            return target == base .. encoded
        end
    end
    return false
end
local function valid_data(value)
    if type(value) ~= "table" or value.schemaVersion ~= 2 or value.release ~= "v013-hangzhou-20261006-1f742992"
        or value.fallbackBase ~= "https://ark-asset.hanabi-ai.cn:25442/releases/v013-hangzhou-20261006-1f742992"
        or value.modelscopeBase ~= "https://modelscope.cn/datasets/Stardust/arknight-assets/resolve/34fa98b056c7554b8dbea7a4e18e78b6c6445fbb/releases/v013-modelscope-20261006-1f742992-174200/"
        or type(value.paths) ~= "table" or value.openiWeight ~= 40 or value.modelscopeWeight ~= 60 or value.ningxiaWeight ~= 0 then return false end
    local fields = { schemaVersion = true, release = true, fallbackBase = true, modelscopeBase = true,
        modelscopeBases = true, paths = true, openiWeight = true, modelscopeWeight = true, ningxiaWeight = true }
    for field in pairs(value) do if not fields[field] then return false end end
    if #modelscope_bases == 1 then
        if value.modelscopeBases ~= nil then return false end
    else
        if type(value.modelscopeBases) ~= "table" or #value.modelscopeBases ~= #modelscope_bases then return false end
        for index, base in pairs(value.modelscopeBases) do
            if modelscope_bases[index] ~= base then return false end
        end
    end
    for alias in pairs(openi_only) do if value.paths[alias] ~= false then return false end end
    local count = 0
    for alias, target in pairs(value.paths) do
        if not public_path(alias) then return false end
        if openi_only[alias] then
            if target ~= false then return false end
        elseif not model_target_allowed(target) then return false end
        count = count + 1
        if count > __MATERIAL_LB_MAX_ENTRIES__ then return false end
    end
    return count > 0
end
local db = package.loaded[key]
if db == nil then
    local file = io.open("__MATERIAL_LB_DATA__", "rb")
    local raw
    if file then
        raw = file:read("*a")
        file:close()
    end
    db = type(raw) == "string" and cjson.decode(raw) or nil
    if not valid_data(db) then db = false end
    package.loaded[key] = db
end
if type(db) ~= "table" then return ngx.exit(500) end

local method = ngx.req.get_method()
if method ~= "GET" and method ~= "HEAD" and method ~= "OPTIONS" then return ngx.exit(405) end
local target = ngx.var.request_uri or ""
if #target > 8192 or target:find("#", 1, true) or target:find("[%z\1-\31\127]") then
    return ngx.exit(404)
end
local raw = target:match("^[^?]*")
local lower = raw:lower()
if lower:find("%%2f") or lower:find("%%5c") then return ngx.exit(404) end
local remaining = raw:gsub("%%[%da-fA-F][%da-fA-F]", "")
if remaining:find("%%") then return ngx.exit(404) end
local path = ngx.unescape_uri(raw)
if not (path:sub(1, 8) == "/assets/" or path:sub(1, 7) == "/media/") then return ngx.exit(404) end
for segment in path:gmatch("[^/]+") do
    if not segment:match("^[A-Za-z0-9_%[%]-][A-Za-z0-9_.%[%]-]*$") or segment:sub(-1) == "." then
        return ngx.exit(404)
    end
end
local model_target = db.paths[path]
if model_target == nil then return ngx.exit(404) end
if openi_only[path] then
    if model_target ~= false then return ngx.exit(500) end
elseif not model_target_allowed(model_target) then return ngx.exit(500) end
if method == "OPTIONS" then return end

ngx.ctx.material_lb_known = true
ngx.ctx.material_lb_path = path
ngx.ctx.material_lb_fallback = db.fallbackBase .. path:gsub("([^A-Za-z0-9_/.-])", function(char)
    return string.format("%%%02X", string.byte(char))
end)
if method == "HEAD" then
    -- Preserve the existing metadata-probe/fallback contract; ordinary GET has no Ningxia allocation.
    ngx.ctx.material_lb_selected = "ningxia"
    return ngx.redirect(ngx.ctx.material_lb_fallback, 302)
end
local request_id = ngx.var.request_id or ""
if #request_id ~= 32 or not request_id:match("^[%da-fA-F]+$") then return ngx.exit(500) end
local number = tonumber(request_id:sub(1, 8), 16)
if not number then return ngx.exit(500) end
-- Uniform 32-bit request IDs: rounded 60% boundary differs by less than 1 / 2^32.
if model_target ~= false and number < 2576980378 then
    ngx.ctx.material_lb_selected = "modelscope"
    return ngx.redirect(model_target, 302)
end
ngx.ctx.material_lb_selected = "openi"
-- Continue through the unchanged OpenI proxy and its existing failure fallback.
