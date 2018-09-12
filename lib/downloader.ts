import * as requests from "request";
import { EventEmitter } from "events"
import * as fs from "fs"
import { normalize } from "path"

export class PigDownloader {

    jar: requests.CookieJar

    constructor(jar: requests.CookieJar = requests.jar()) {
        this.jar = jar
    }

    download(url: string, file: string, threadCount: number = 8, options: requests.CoreOptions = { jar: this.jar }) {
        if (!options.jar) options.jar = this.jar
        return new DownloadItem(url, file, threadCount, options)
    }
}

enum DownloadItemState {
    INIT, PREPARED, COMPLETE, ERROR, DOWNLOADING, PAUSED, CANCELED
}

const CHANGESTATE_EVENT = Symbol("ChangeState")

class DownloadItem extends EventEmitter {

    readonly events = {
        error: "error",
        prepared: "prepared",
        stateChanged: "stateChanged",
        data: "data",
        complete: "complete",
        speedUpdate: "speedUpdate"
    }
    threadCount: number
    file: string
    url: string
    options: requests.CoreOptions
    totalLength = -1
    downloadedLength = 0
    oldLength = 0
    rangeEnabled = false
    downloadType: "Single" | "Multi" = "Single"
    parts: DownloadPart | null = null
    fd: number = 0
    speedInterval = 1000
    private state = DownloadItemState.INIT

    constructor(url: string, file: string, threadCount: number, options: requests.CoreOptions) {
        super()
        this.url = url
        this.options = options
        this.file = normalize(file)
        this.threadCount = threadCount
        this.on(CHANGESTATE_EVENT, (state) => {
            this.changeState(state)
        })
        requests.head(url, options, (error, resp: requests.Response) => {
            if (error) {
                this.emit(this.events.error, error)
                this.changeState(DownloadItemState.ERROR)
                return
            }
            if (resp.headers["content-length"]) {
                this.totalLength = parseInt(resp.headers["content-length"] as string)
            }
            if (resp.headers["accept-ranges"]) {
                this.rangeEnabled = (resp.headers["accept-ranges"] == "bytes")
            }
            if (this.totalLength != -1 && this.rangeEnabled) this.downloadType = "Multi"
            else {
                let op = { headers: { range: "bytes=0-1" } }
                requests.default(url, op, (err, res) => {
                    if (err) {
                        this.emit(this.events.error, error)
                        return
                    }
                    if (res.headers["content-length"]) {
                        this.totalLength = parseInt(res.headers["content-length"] as string)
                    }
                    if (res.headers["accept-ranges"]) {
                        this.rangeEnabled = (res.headers["accept-ranges"] == "bytes")
                    }
                    if (this.totalLength != -1 && this.rangeEnabled) this.downloadType = "Multi"
                    this.changeState(DownloadItemState.PREPARED)
                })
                return
            }
            this.changeState(DownloadItemState.PREPARED)
            this.emit(this.events.prepared)
        })
    }

    private changeState(state: DownloadItemState) {
        this.emit(this.events.stateChanged, this.state, state)
        this.state = state
        if (state == DownloadItemState.PREPARED) this.emit(this.events.prepared)
        if (state == DownloadItemState.COMPLETE) this.emit(this.events.complete)
    }

    start() {
        if (this.state == DownloadItemState.INIT) {
            this.once(this.events.prepared, this.start)
            return
        } else if (this.state == DownloadItemState.PREPARED) {
            this.fd = fs.openSync((this.file), "w")
            if (this.downloadType == "Multi") {
                let ranges = []
                let partSize = parseInt((this.totalLength / this.threadCount) + "")
                for (let i = 0, size = 0; i < this.threadCount; i++ , size += partSize) {
                    ranges.push(size)
                }
                ranges.push(this.totalLength)
                let parts = new DownloadPart(this.url, this.fd, this.options, ranges[0], ranges[1] - 1, this);
                (parts as any).i = 0
                this.parts = parts
                for (let i = 1; i < this.threadCount; i++) {
                    parts.next = new DownloadPart(this.url, this.fd, this.options, ranges[i], ranges[i + 1] - 1, this);
                    (parts as any).i = i
                    parts = parts.next
                }
                let parts2: DownloadPart | null = this.parts
                while (parts2 != null) {
                    parts2.start()
                    parts2 = parts2.next
                }
                this.changeState(DownloadItemState.DOWNLOADING)
            } else {
                this.singleStart()
            }
        }
    }

    private singleStart() {
        requests.default(this.url, this.options).on("data", (data) => {
            let buffer: Buffer = data instanceof Buffer ? data : new Buffer(data)
            fs.writeSync(this.fd, buffer, 0, buffer.length, this.downloadedLength)
            this.downloadedLength += buffer.length
            this.emit(this.events.data, this)
        }).on("error", (e) => {
            this.start()
        }).on("complete", () => {
            if (this.totalLength != -1 && this.downloadedLength < this.totalLength) this.singleStart()
            else this.changeState(DownloadItemState.COMPLETE)
        })
        this.changeState(DownloadItemState.DOWNLOADING)
    }

    pause() {
        let p = this.parts
        while (p != null) {
            p.pause()
            p = p.next
        }
        this.changeState(DownloadItemState.PAUSED)
    }

    resume() {
        let p = this.parts
        while (p != null) {
            p.resume()
            p = p.next
        }
        this.changeState(DownloadItemState.DOWNLOADING)
    }

    cancel() {
        let p = this.parts
        while (p != null) {
            p.cancel()
            p = p.next
        }
        this.changeState(DownloadItemState.CANCELED)
    }
}

class DownloadPart extends EventEmitter {
    url: string
    file: number
    item: DownloadItem
    next: DownloadPart | null = null
    head: number
    end: number
    options: requests.CoreOptions
    current: number
    constructor(url: string, file: number, options: requests.CoreOptions, start: number, end: number, item: DownloadItem) {
        super()
        this.url = url
        this.item = item
        this.file = file
        this.head = start
        this.end = end
        this.current = start
        this.options = options
    }

    start() {
        let o = { ...this.options }
        if (!o.headers) o.headers = {}
        let headers = o.headers as any
        headers["Range"] = `bytes=${this.current}-${this.end}`
        let r = requests.default(this.url, o).on("data", (data) => {
            let buffer: Buffer = data instanceof Buffer ? data : new Buffer(data)
            fs.writeSync(this.file, buffer, 0, buffer.length, this.current)
            this.current += buffer.length
            this.item.downloadedLength += buffer.length
            this.item.emit(this.item.events.data, this)
        }).on("error", (e) => {
            this.start()
        }).on("complete", () => {
            if (this.current < this.end) this.start()
            else if (this.item.downloadedLength >= this.item.totalLength) this.item.emit(CHANGESTATE_EVENT, DownloadItemState.COMPLETE)
        })
        this.on("pause", () => {
            r.pause()
        })
        this.on("resume", () => {
            r.resume()
        })
        this.on("cancel", () => {
            r.abort()
        })
    }

    pause() {
        this.emit("pause")
    }

    resume() {
        this.emit("resume")
    }

    cancel() {
        this.emit("cancel")
    }

}