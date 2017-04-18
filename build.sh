#!/usr/bin/env bash
bower install
python download-google-smart-card-client-library.py

rm -rf build
mkdir build
declare -a files=("popup.html"
                  "popup.js"
                  "popup.css"
                  "pinCache.js"
                  "manifest.json"
                  "google-smart-card-client-library.js"
                  "bower_components/mithril/mithril.min.js"
                  "bower_components/chrome-promise/chrome-promise.js"
                  "bower_components/openpgp/dist/openpgp.min.js"
                  "bower_components/material-design-icons/action/1x_web/ic_search_black_24dp.png"
                  "bower_components/material-design-icons/action/1x_web/ic_lock_open_24dp.png"
                  "bower_components/material-design-icons/communication/1x_web/ic_vpn_key_black_24dp.png"
                  "bower_components/material-design-icons/communication/1x_web/ic_vpn_key_black_48dp.png"
                  "bower_components/material-design-icons/communication/2x_web/ic_vpn_key_black_48dp.png"
                  "bower_components/material-design-icons/content/1x_web/ic_content_copy_black_24dp.png"
                  "bower_components/material-design-icons/hardware/1x_web/ic_sim_card_black_24dp.png")

cp --parents "${files[@]}" build/
cp LICENSE_build build/LICENSE

cd build
zip -r ../cros-sc-pass.zip *
