var crypto = require('crypto');
var fs = require('fs');
var request = require('request');
var twitter = require('twit');
var twitAuth = require('./twit_auth');
var bot = new twitter(twitAuth);
var hashData = './sightings.json';

function getBirds() {
    request({
        url: "http://ebird.org/ws1.1/data/notable/region/recent?rtype=subnational1&r=US-MA&fmt=json&back=1",
        json: true
    }, function (err, res, body) {

        if (!err && res.statusCode === 200) {
            valid(body);
        }
    });
}

function valid(sightings) {
    var prev = fs.readFileSync(hashData,'utf8');
    if (typeof sightings != 'undefined') {
        var valid_new = [];
        sightings.forEach(function(item, index) {
            var hashid = hash(item);
            if (item.obsValid === true && prev.indexOf(hashid) == -1) {
                valid_new.push(item);
            }
        });
        if (valid_new.length > 15) {
            valid_new.length = 15;
        }
        tweet(valid_new);
        store(prev, valid_new);
    }
}

function hash(data) {
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

function tweet(arr) {
    arr.forEach(function(item, index) {
        var birdUp = item.howMany + ' ' + item.comName + ' (' + item.sciName + ') sighted at ' + item.locName + ' on ' + item.obsDt;
        bot.post('statuses/update', { status: birdUp, lat: item.lat, long: item.lng, place_id: item.locName }, function(err, reply) {
            if(err) {
                console.log(err);
            }
        });
    });
}

function store(done, current) {
    if (done !== '') {
        old = JSON.parse(done);
    }
    var timestamp = Math.round(new Date().getTime() / 1000);
    var stash = {};
    if (typeof old != 'undefined') {
        for (var index in old) {
            if (old[index] > timestamp - (60 * 60 * 24)) {
                stash[index] = old[index];
            }
        }
    }
    current.forEach(function(item, index) {
        var curhash = hash(item);
        stash[curhash] = timestamp;
    });
    fs.writeFile(hashData, JSON.stringify(stash), function(err) {
        if(err) {
            console.log(err);
        }
    });
}

setInterval(getBirds, 15 * 60 * 1000);
