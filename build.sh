#!/usr/bin/env bash
yarn install
python download-google-smart-card-client-library.py

rm -rf build
rm smart-pass.zip

mkdir build
declare -a files=("background.js"
                  "popup.html"
                  "popup.js"
                  "popup.css"
                  "pinCache.js"
                  "manifest.json"
                  "google-smart-card-client-library.js"
                  "node_modules/mithril/mithril.min.js"
                  "node_modules/chrome-promise/chrome-promise.js"
                  "node_modules/openpgp/dist/openpgp.min.js"
                  "node_modules/material-design-icons/action/1x_web/ic_search_black_24dp.png"
                  "node_modules/material-design-icons/action/1x_web/ic_lock_open_black_24dp.png"
                  "node_modules/material-design-icons/communication/1x_web/ic_vpn_key_black_24dp.png"
                  "node_modules/material-design-icons/communication/1x_web/ic_vpn_key_black_48dp.png"
                  "node_modules/material-design-icons/communication/2x_web/ic_vpn_key_black_48dp.png"
                  "node_modules/material-design-icons/content/1x_web/ic_content_copy_black_24dp.png"
                  "node_modules/material-design-icons/hardware/1x_web/ic_sim_card_black_24dp.png")

cp --parents "${files[@]}" build/
cp LICENSE.build build/LICENSE

cd build
zip -r ../smart-pass.zip *
