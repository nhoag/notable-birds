var winston = require('winston');
var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.File)({ filename: '/var/log/nbirds/error.log' })
  ],
  exitOnError: false
});

function dbConnect() {
  var url      = require('url');
  var redisUrl = url.parse(process.env.REDIS_URL);
  var redis    = require('redis'),
      client   = redis.createClient(redisUrl.port, redisUrl.hostname);
  var key      = process.env.NB_REGION;
  return {
    client: client,
    key: key
  };
}

function readDb(callback) {
  var db = dbConnect();

  var value = JSON.stringify({'limit': '', 'sightings': ''});
  db.client.setnx(db.key, value);
  db.client.get(db.key, function(err, reply) {
    callback(reply);
    db.client.quit();
  });
}

function writeDb(value) {
  var db = dbConnect();

  db.client.set(db.key, value);
  db.client.quit();
}

function getSightings(prev, callback) {
  var http     = require('http');
  var endpoint = '/ws1.1/data/notable/region/recent?';
  var rgnType  = 'rtype=subnational1';
  var rgn      = '&r=' + process.env.NB_REGION;
  var fmt      = '&fmt=json';
  var back     = '&back=' + process.env.NB_BACK;
  var query    = rgnType + rgn + fmt + back;
  var path     = endpoint + query;
  var options = {
    host: 'ebird.org',
    port: 80,
    path: path,
    method: 'GET'
  };
  var req = http.request(options, function(res) {
    res.setEncoding('utf-8');
    var str = '';
    res.on('data', function (chunk) {
      str += chunk;
    });
    res.on('end', function() {
      var data = {};
      data.prev = prev;
      data.sightings = JSON.parse(str);
      callback(data);
    });
  });
  req.on('error', function(e) {
    logger.warn('problem with request: ' + e.message);
  });
  req.end();
}

function dataHash(data) {
  var crypto = require('crypto');
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

function valid(sightings) {
  var validNew = [];
  if (typeof sightings != 'undefined') {
    sightings.forEach(function(item, index) {
      if (item.obsValid === true) {
        validNew.push(item);
      }
    });
  }
  return validNew;
}

function unique(data) {
  var uniqSightings = [];
  var hashes        = [];
  if (typeof data != 'undefined') {
    var index;
    for (index = 0; index < data.length; ++index) {
      var hashId = dataHash(data[index]);
      if (hashes.indexOf(hashId) == -1) {
        hashes.push(hashId);
        uniqSightings.push(data[index]);
      }
    }
  }
  return uniqSightings;
}

function newBirds(data, prev) {
  if (typeof prev == 'undefined') {
    return data;
  } else {
    var novel = [];
    if (typeof data != 'undefined') {
      var index;
      for (index = 0; index < data.length; ++index) {
        var hashId = dataHash(data[index]);
        if (JSON.stringify(prev).indexOf(hashId) == -1) {
          novel.push(data[index]);
        }
      }
    }
    return novel;
  }
}

function buildTweet(sighting) {
  var update = '';
  if (typeof sighting.howMany != 'undefined') {
    update = sighting.howMany + ' ';
  }
  update += sighting.comName;
  update += ' (' + sighting.sciName + ')';
  update += ' - ' + sighting.locName.replace(/\(.*?\)\s/g, '');
  update += ' - ' + sighting.obsDt;
  update = trimTweet(update);
  if (update.length + 23 <= 140) {
    var birdName = sighting.comName.replace(/ \(.*?\)/, '').replace(/ /g, '_').replace(/'/g, '');
    var birdLink = 'http://www.allaboutbirds.org/guide/' + birdName + '/id';
    update += ' ' + birdLink;
  }
  return update;
}

function trimTweet(update) {
  if (update.length > 140) {
    update = update.replace(/-\s/g, '');
  }
  if (update.length > 140) {
    update = update.replace(/\s\d{2}:\d{2}/, '');
  }
  if (update.length > 140) {
    update = update.replace(/\(.*?\)\s/g, '');
  }
  return update;
}

function tweet(sightings) {
  var twitter = require('twit');
  var T = new twitter({
      consumer_key:         process.env.NB_T_CONSUMER_KEY
    , consumer_secret:      process.env.NB_T_CONSUMER_SECRET
    , access_token:         process.env.NB_T_ACCESS_TOKEN
    , access_token_secret:  process.env.NB_T_ACCESS_TOKEN_SECRET
  });

  sightings.forEach(function(item, index) {
    update = buildTweet(item);

    T.post('statuses/update', {
        status: update
      , lat: item.lat
      , long: item.lng
      , place_id: item.locName
    }, function(err, data, response) {
      if(err) {
        logger.warn(err);
      }
    });
  });
}

function limitResetAll() {
  var limit = {};
  limit = limitResetFifteen(limit);
  limit = limitResetDaily(limit);
  return limit;
}

function limitResetFifteen(limit) {
  limit.fifteenMin = {};
  limit.fifteenMin.remain = 180;
  limit.fifteenMin.reset  = Math.round(Date.now() / 1000 + 15 * 60);
  return limit;
}

function limitResetDaily(limit) {
  limit.daily = {};
  limit.daily.remain = 2400;
  limit.daily.reset  = Math.round(Date.now() / 1000 + 24 * 60 * 60);
  return limit;
}

function limitReset(interval, limit) {
  if (interval == 'all') {
    limit = limitResetAll();
  } else if (interval == 'fifteenMin') {
    limit = limitResetFifteen(limit);
  } else if (interval == 'daily') {
    limit = limitResetDaily(limit);
  }
  return limit;
}

function rateLimit(limit) {
  if (limit === '') {
    limit = limitReset('all', limit);
  } else if (Math.round(Date.now() / 1000) >= limit.daily.reset) {
    limit = limitReset('daily', limit);
  } else if (Math.round(Date.now() / 1000) >= limit.fifteenMin.reset) {
    limit = limitReset('fifteenMin', limit);
  }
  return limit;
}

function truncateSightings(sightings, rl) {
  var daily = rl.daily.remain;
  var fifteenMin = rl.fifteenMin.remain;
  var limit = daily <= fifteenMin ? daily : fifteenMin;
  sightings.length = limit < sightings.length ? limit : sightings.length;
  return sightings;
}

function dbStore(prev, sightings, limit) {
  limit.fifteenMin.remain = limit.fifteenMin.remain - sightings.length;
  limit.daily.remain = limit.daily.remain - sightings.length;
  var timeStamp = Math.round(Date.now() / 1000);
  var stash = dbPrune(prev, timeStamp);
  var value = {};
  var index;
  for (index = 0; index < sightings.length; ++index) {
    var hashId = dataHash(sightings[index]);
    stash[hashId] = timeStamp;
  }
  value.sightings = stash;
  value.limit = limit;
  writeDb(JSON.stringify(value));
}

function dbPrune(prev, timeStamp) {
  if (typeof prev != 'undefined') {
    var stash = {};
    for (var index in prev) {
      if (prev[index] > timeStamp - (60 * 60 * 24 * (parseInt(process.env.NB_BACK) + 1))) {
        stash[index] = prev[index];
      }
    }
    return stash;
  }
}

function nbController() {
  readDb(function(prev) {
    getSightings(prev, function(data) {
      var uniq = unique(valid(data.sightings));
      var prev = JSON.parse(data.prev);
      var novel = newBirds(uniq, prev.sightings);
      var rl = rateLimit(prev.limit);
      var sightings = truncateSightings(novel, rl);
      tweet(sightings);
      dbStore(prev.sightings, sightings, rl);
    });
  });
}

nbController();
