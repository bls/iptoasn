"use strict";

const EventEmitter = require('events');
const util = require('util');
const sorted = require('sorted');
const byline = require('byline');
const fs = require('fs');
const ip = require('ip');
const http = require('http');

const bgpTableUrl = "http://thyme.apnic.net/current/data-raw-table";
const asnNamesUrl = "http://thyme.apnic.net/current/data-used-autnums";

const bgpTableFilename = "bgp-raw-table.txt";
const asnNamesFilename = "used-autnums.txt";

const bgpDbFilename = "db.txt";

let ASNNames = {};
let BGPTable = sorted();

// FIXME: recursion probably isn't the most efficient solution...
function _findInSortedRanges(db, ipLong, fromIndex, toIndex) {
  if(fromIndex > toIndex) return null; // not found :(

  let m = parseInt((fromIndex + toIndex) / 2);
  let a = db.get(m);

  if(a[0] < ipLong && a[1] < ipLong) {
    return _findInSortedRanges(db, ipLong, m+1, toIndex);
  } else if(a[0] > ipLong && a[1] > ipLong) {
    return _findInSortedRanges(db, ipLong, fromIndex, m-1);
  } else if(a[0] <= ipLong && a[1] >= ipLong) {
    return a;
  }

  throw new Error("BUG?");
}

function findInSortedRanges(db, ipv) {
  let iplong;
  if(typeof ipv == "string") {
    iplong = ip.toLong(ipv);
  } else {
    iplong = ipv;
  }

  return _findInSortedRanges(db, iplong, 0, db.length-1);
}

class IPtoASN extends EventEmitter {
  constructor(cachedir) {
    super();
    this.cachedir = cachedir;

    // FIXME: should be async probably
    try {
      fs.mkdirSync(cachedir);
    } catch(e) {}
  }

  _load() {
    fs.readFile(this.cachedir + "/" + bgpDbFilename, (err, data) => {
      if(err) throw err;
      BGPTable = sorted(JSON.parse(data), (aa,bb) => {
        let a = aa[0];
        let b = bb[0];
        if (a == b) return 0
        else if (a > b) return 1
        else if (a < b) return -1
        else throw new RangeError('Unstable comparison: ' + a + ' cmp ' + b)
      });

      let rstream = byline(fs.createReadStream(this.cachedir + "/" + asnNamesFilename));
      rstream.on("data", (line) => {
        let tokens = line.toString().trim().split(" ");
        let asn = tokens.shift();
        let name = tokens.join(" ");
        ASNNames[asn] = { asn, name };
      });
      rstream.on("end", () => {
        this.emit("ready");
      });
    });
  }

  _update(url, filename, callback) {
    http.get(url, (response) => {
      const writeStream = fs.createWriteStream(this.cachedir + "/" + filename);
      response.on("data", (chunk) => writeStream.write(chunk));
      response.on("end", () => {
        writeStream.close();
        if(callback)
          callback();
      });
    });
  }

  _parseBGPTable(callback) {
    let rstream = byline(fs.createReadStream(this.cachedir + "/" + bgpTableFilename));

    let db = [];

    rstream.on("data", (data) => {
      let tokens = data.toString().trim().split("\t");
      let network = ip.cidrSubnet(tokens[0]);

      let start = ip.toLong(network.firstAddress);
      let end = ip.toLong(network.lastAddress);
      let asn = tokens[1];

      db.push([start, end, asn]);
    });

    rstream.on("end", () => {
      db.sort((a, b) => {
        return a[0] - b[0];
      });
      fs.writeFile(this.cachedir + "/" + bgpDbFilename, JSON.stringify(db), callback);
    });
  }

  load(options) {
    if(!options) options = {};
    if(options.update) {
      // FIXME: make it parallel instead of sequential. promises maybe?
      // FIXME: unsafe when run from multiple processes
      this._update(bgpTableUrl, bgpTableFilename, () => {
        this._update(asnNamesUrl, asnNamesFilename, () => {
          this._parseBGPTable(() => {
            this._load();
          });
        });
      });
    } else {
      this._load();
    }
  }

  lastUpdated(callback) {
    fs.stat(this.cachedir + "/" + bgpDbFilename, (err, stat) => {
      let daysSinceUpdate;
      // FIXME: should check the error probably...
      if(err) daysSinceUpdate = Infinity;
      else {
        let msSinceUpdate = new Date() - new Date(stat.mtime);
        daysSinceUpdate = msSinceUpdate/1000/3600/24.0;
      }
      callback(null, daysSinceUpdate);
    });
  }

  lookup(ip) {
    let db = findInSortedRanges(BGPTable, ip);
    if(!db) return null;
    return ASNNames[db[2]];
  }
}

module.exports = (cachedir) => {
  return new IPtoASN(cachedir);
};
