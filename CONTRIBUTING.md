Contributing
============

SmartPass uses [yarn](https://yarnpkg.com/) to manage its dependencies.

## Building
Run `build.sh`. This will
  1. install yarn dependencies,
  2. download the [Google Smart Card Client library](https://github.com/GoogleChrome/chromeos_smart_card_connector/releases),
  3. copy all resources into the `build` folder,
  4. compress the contents of the `build` folder into a ZIP file.
  
In order to load the extension into Chrome, activate `Developer mode` on `chrome://extensions` and select the `build` folder after clicking on `Load unpacked extension...`.

## Contributing
  1. Fork [this repository](https://github.com/FabianHenneke/smart-pass).
  2. Create a feature branch with
     `git checkout -b my-new-feature`
  3. Commit your changes via
     `git commit -am "Add new feature"`
  4. Push the branch with
     `git push origin my-new-feature`
  5. Create a pull request.

