# HD static art (rel30)

The original 立绘 of every operator look and where the in-game 180×360 portrait sits in it. The committed result is the
registry `tools/assets/char-illustrations.json`; `node tools/prepare-operator-illustrations.mjs --assets <dir>` writes its
fields into data/assets.json and data/assets-collab.json (`tools/fetch-assets.mjs` keeps them on a rebuild). The pictures
are git-ignored like all art; a material profile carries them (only the collab operators' stay in the Jinan collab pack).

Steps (Python 3 with numpy + Pillow, always `python3 -I`; downloads in their own new folder, never run anything there):

1. `prts_meta.py names.json want.json meta.json` — PRTS imageinfo of 「文件:立绘 <名字> <1|2>.png」 and 「半身像 …」 (40 titles
   per request, 1 s apart, a plain User-Agent). The 卫戍协议 prototypes (char_6xx) use 「<名字>(卫戍协议)」: query them again
   with those names (`alt`).
2. `prts_get.py jobs.json outdir` — sequential downloads from media.prts.wiki only, size + sha1 checked against the API.
3. `identity.py assets.json assets-collab.json roots.json dl-portrait out.json` — each PRTS 半身像 against the in-game
   portrait (mean abs difference ~3/255 is two decodes of one client picture); picks the variant per look.
4. `portrait_box.py jobs.json out.json hd_out [i/n]` — scale + offset by masked SSD on the portrait's opaque pixels (coarse
   1/4 → full resolution), anti-aliased PSNR, `bgShare` (a scene behind the character the portrait does not show); writes the
   native-resolution crop, a cut-out with the portrait's upscaled alpha when there is a scene.
5. `check_boxes.py box-results jobs.json check.json` — masked luminance NCC and the inlier share of every box (the review list).
6. `review.py box-results check.json [box-retry.json check-retry.json] jobs.json hd_out hd_out_retry out_dir [P0 G0 N]` — accepts a box
   when its PSNR ≥ P0 (18) or else its gradient NCC ≥ G0 (0.12), takes a retry run's box (`-` when there is none) where only that one
   passes, and writes box-final.json, check-final.json, misses.json and review sheets of the N (40) lowest-scoring accepted looks.
7. `build_registry.py box-results provenance.json jobs.json hd_out stage registry.json [min_psnr] [min_hd_gain] [check.json] [misses.json] [no-hd.json]`
   — the registry and a staging tree laid out like public/assets. A miss gets nothing (the look keeps its portrait): misses.json lists the
   boxes confirmed wrong by eye — render portrait | resample side by side for every look with a low NCC / inlier score;
   effects or scenery the 立绘 draws over the character lower both a lot on correct matches too. Every other look gets its 立绘 and box; its `portraitHD` only when the box is at least 180 px wide —
   where the character is small in a wide composition the in-game portrait is already near (or above) native, and a
   narrower crop would be coarser than it (`gain` = box width / 180 in the registry). no-hd.json lists looks that keep their in-game
   portrait although matched (e.g. official effects drawn over the character): box only.
