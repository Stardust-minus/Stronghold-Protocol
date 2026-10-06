local cjson = require "cjson.safe"
local key = "ark_material_lb_20261006_model60_v3"
local db = package.loaded[key]
if not db then
    local file = io.open("__MATERIAL_LB_DATA__", "rb")
    if not file then return ngx.exit(500) end
    local raw = file:read("*a")
    file:close()
    db = cjson.decode(raw)
    if not db or db.schemaVersion ~= 2 or db.release ~= "v013-hangzhou-20261006-1f742992"
        or db.fallbackBase ~= "https://ark-asset.hanabi-ai.cn:25442/releases/v013-hangzhou-20261006-1f742992"
        or db.modelscopeBase ~= "https://modelscope.cn/datasets/Stardust/arknight-assets/resolve/34fa98b056c7554b8dbea7a4e18e78b6c6445fbb/releases/v013-modelscope-20261006-1f742992-174200/"
        or type(db.paths) ~= "table" or db.openiWeight ~= 40 or db.modelscopeWeight ~= 60 or db.ningxiaWeight ~= 0 then
        return ngx.exit(500)
    end
    package.loaded[key] = db
end

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
if not model_target then return ngx.exit(404) end
if type(model_target) ~= "string" or model_target:sub(1, #db.modelscopeBase) ~= db.modelscopeBase then
    return ngx.exit(500)
end
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
if number < 2576980378 then
    ngx.ctx.material_lb_selected = "modelscope"
    return ngx.redirect(model_target, 302)
end
ngx.ctx.material_lb_selected = "openi"
-- Continue through the unchanged OpenI proxy and its existing failure fallback.
