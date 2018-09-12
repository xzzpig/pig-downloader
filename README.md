# pig-downloader
A Multithread Downloader for NodeJS

[![MIT Licence](https://badges.frapsoft.com/os/mit/mit.svg?v=103)](https://opensource.org/licenses/mit-license.php) 
[![NPM version](https://img.shields.io/npm/v/pig-downloader.svg)](https://www.npmjs.com/package/pig-downloader)

-------------------
### Install
```
npm install --save pig-downloader
```
-------------------
### Example
```Typescript
import { PigDownloader } from "pig-downloader";
let downloader = new PigDownloader()
let item = downloader.download("DOWNLOAD URL HERE", "./example.file", 16)
item.on(item.events.data, (i) => {
    let parts = item.parts
    let str = "|"
    while (parts != null) {
        str += `${((parts.current - parts.head) * 100 / (parts.end - parts.head)).toFixed(2)}%|`
        parts = parts.next
    }
    console.log(str)
}).on(item.events.complete, () => {
    console.log("complete")
})
item.start()
```
