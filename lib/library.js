// Load tracks
var colors = require('colors'),
    fs = require('fs'),
    lwip = require('lwip'),
    path = require('path'),
    config = require('config'),
    LastfmAPI = require('lastfmapi'),
    http = require('http');

var lastFM = new LastfmAPI({
    'api_key' : config.get('LastFM.key'),
    'secret' : config.get('LastFM.secret')
});

var Library = function(db, callback) {
    var self = this;

    // Keep track of callbacks
    this.watchers = [];

    this.db = db;

    this.initiated = false;
    this.tracks = [];

    // Load in library
    self.db.all("SELECT * FROM tracks ORDER BY artist, track", function(err, rows) {
        if (err) {
            console.log('Error loading library'.red);
            return;
        }

        self.tracks = rows;

        self.initiated = true;

        if (callback && typeof(callback) === "function") {
            callback.call(self);
        }
    });
}


/**
 * Count number of tracks in the library
 * @return {Number} track id
 */
Library.prototype.countTracks = function() {
    return this.tracks.length;
}

/**
 * Update DB
 * @param {Number} track id
 */
Library.prototype.playingTrack = function(track_id, channel_id) {
    // Update library
    var stmt = this.db.prepare("UPDATE tracks SET `last` = datetime(), plays = IFNULL(plays, 0) + 1 WHERE id = ?");
    stmt.run(track_id);

    // Update channel
    if (channel_id) {
        var stmt = this.db.prepare("UPDATE channels_tracks SET `last` = datetime(), plays = IFNULL(plays, 0) + 1 WHERE track_id = ? AND channel_id = ?");
        stmt.run(track_id, channel_id);
    }
}

/**
 * Rate track
 * @param {Number} track id
 * @param {Number} uuid
 */
Library.prototype.rateTrack = function(trackID, channelID, uuid, rating, callback) {
    if (rating !== 1 && rating !== 0 && rating !== -1) return;

    var self = this;

    try {
        // Delete any previous ratings
        var stmt = this.db.prepare("DELETE FROM tracks_ratings WHERE `uuid` = ? AND `track` = ? AND `channel` = ?");
        if (rating == 1 || rating == -1) {
            stmt.run(uuid, trackID, channelID, function() {
                // Add new rating
                var stmt = self.db.prepare("INSERT INTO tracks_ratings (`uuid`, `track`, `channel`, `rating`) VALUES (?, ?, ?, ?)");
                stmt.run(uuid, trackID, channelID, rating);

                // Get updated ratings
                self.lookupTrackID(trackID, channelID, function(track) {
                    var data = {channelID: channelID, trackID: trackID, up: track.up, down: track.down, up_uuid: track.up_uuid, down_uuid: track.down_uuid};
                    self.emit('rated', data);

                    if (callback && typeof(callback) === "function") {
                        callback(data);
                    }
                });
            });
        } else {
            // Get updated ratings
            self.lookupTrackID(trackID, channelID, function(track) {
                var data = {channelID: channelID, trackID: trackID, up: track.up, down: track.down, up_uuid: track.up_uuid, down_uuid: track.down_uuid};
                self.emit('rated', data);

                if (callback && typeof(callback) === "function") {
                    callback(data);
                }
            });
        }
    } catch(e) {
        console.log(e);
    }
}


/**
 * Get track details
 * @param {Number} track id
 * @param {Function} callback [{Object} track details]
 * @return {Object} track details (only if callback is not set)
 */
Library.prototype.lookupTrackID = function(id, channelID, callback) {
    var self = this;

    // If callback check against DB, else use quick method
    if (callback && typeof(callback) === "function") {
        var stmt = this.db.prepare("SELECT tracks.*, IFNULL(ratings_up.up, 0) AS up, ratings_up.up_uuid, IFNULL(ratings_down.down, 0) AS down, ratings_down.down_uuid\
                                    FROM tracks\
                                    INNER JOIN channels_tracks\
                                    ON channels_tracks.channel_id = ? AND channels_tracks.track_id = tracks.id\
                                    LEFT JOIN (SELECT track, COUNT(*) AS up, GROUP_CONCAT(uuid) AS up_uuid FROM tracks_ratings WHERE rating > 0 AND channel = ? GROUP BY track) ratings_up\
                                    ON ratings_up.track = tracks.id\
                                    LEFT JOIN (SELECT track, COUNT(*) AS down, GROUP_CONCAT(uuid) AS down_uuid FROM tracks_ratings WHERE rating < 0 AND channel = ? GROUP BY track) ratings_down\
                                    ON ratings_down.track = tracks.id\
                                    WHERE tracks.id = ?");
        stmt.get(channelID, channelID, channelID, id, function(err, track) {
            if (!track) {
                callback();
                return;
            }

            // Make sure artist has background image
            self.generateArtistBackground(track.artist);

            // Remove default last.fm album art
            if (track.image == 'http://cdn.last.fm/flatness/catalogue/noimage/2/default_album_medium.png') {
                track.image = '';
            }

            // Update our cache
            if (self.tracks) {
                self.tracks[track.id] = track;
            }

            callback(track);
        });
    } else {
        for (var n = 0; n < this.tracks.length; n++) {
            if (this.tracks[n].id == id) {
                return this.tracks[n];
            }
        }
        return false;
    }
}

/**
 * Get track details
 * @param {String} track
 * @param {String} artist
 * @param {Function} callback [{Object} track details]
 * @return {Object} track details (only if callback is not set)
 */
Library.prototype.lookupTrack = function(track, artist, callback) {
    // If callback check against DB, else use quick method
    if (callback && typeof(callback) === "function") {
        var stmt = this.db.prepare("SELECT * FROM tracks WHERE track = ? AND artist = ?");
        stmt.get(array(track, artist), function(err, track) {
            callback(track);
        });
    } else {
        for (var n = 0; n < this.tracks.length; n++) {
            if (this.tracks[n].track == track && (!artist || this.tracks[n].artist == artist)) {
                return this.tracks[n];
            }
        }
        return false;
    }
}

/**
 * Add track
 * @param {Object} track details
 */
Library.prototype.addTrack = function(data) {
    // Add to tracklist
    this.tracks.push({
        id: data.id,
        track: data.track,
        artist: data.artist,
        image: data.image,
        youtube: data.YTID
    });

    // Add to db
    try {
        var stmt = this.db.prepare("INSERT OR IGNORE INTO tracks (`id`, `track`, `artist`, `image`, `youtube`) VALUES (?, ?, ?, ?, ?)");
        stmt.run(data.id, data.track, data.artist, data.image, data.YTID);
        console.log('Track added:', data.track, data.artist);
    } catch(e) {
        console.log(e);
    }

    // Download artist background image
    this.generateArtistBackground(data.artist);

    // Emit event
    this.emit('added', data.id);
}

/**
 * Get tracks for given channel
 * @param {Number} channel id
 * @param {Function} callback [{Object} track details]
 */
Library.prototype.getTracks = function(channel_id, callback) {
    var self = this;

    var stmt = this.db.prepare("SELECT tracks.*, IFNULL(ratings_up.up, 0) AS up, ratings_up.up_uuid, IFNULL(ratings_down.down, 0) AS down, ratings_down.down_uuid\
                                FROM tracks\
                                INNER JOIN channels_tracks\
                                ON channels_tracks.channel_id = ? AND channels_tracks.track_id = tracks.id\
                                LEFT JOIN (SELECT track, COUNT(*) AS up, GROUP_CONCAT(uuid) AS up_uuid FROM tracks_ratings WHERE rating > 0 AND channel = ? GROUP BY track) ratings_up\
                                ON ratings_up.track = tracks.id\
                                LEFT JOIN (SELECT track, COUNT(*) AS down, GROUP_CONCAT(uuid) AS down_uuid FROM tracks_ratings WHERE rating < 0 AND channel = ? GROUP BY track) ratings_down\
                                ON ratings_down.track = tracks.id");
    stmt.all(channel_id, function(err, tracks) {
        callback(tracks);
    });
}

/**
 * Get a random track from the library
 * @param {Function} callback [{Number} track id]
 */
Library.prototype.getRandomTrackID = function(channel_id, callback) {
    // Build weighted tracklisting
    var stmt = this.db.prepare("SELECT\
                    id,\
                    julianday('now') - julianday(IFNULL(channels_tracks.last, channels_tracks.added)) AS `since`,\
                    julianday('now') - julianday(IFNULL(channels_tracks.last, channels_tracks.added)) - (IFNULL(ratings_down.down, 0)*5) + IFNULL(ratings_down.down, 0) AS weight\
                 FROM tracks\
                 INNER JOIN channels_tracks\
                 ON channels_tracks.channel_id = ? AND channels_tracks.track_id = tracks.id\
                 LEFT JOIN (SELECT track, COUNT(*) AS up, GROUP_CONCAT(uuid) AS up_uuid FROM tracks_ratings WHERE rating > 0 AND channel = ? GROUP BY track) ratings_up\
                 ON ratings_up.track = tracks.id\
                 LEFT JOIN (SELECT track, COUNT(*) AS down, GROUP_CONCAT(uuid) AS down_uuid FROM tracks_ratings WHERE rating < 0 AND channel = ? GROUP BY track) ratings_down\
                 ON ratings_down.track = tracks.id\
                 WHERE `since` > 0.5 AND IFNULL(ratings_down.down, 0) < 3\
                 ORDER BY weight");

    stmt.all(channel_id, channel_id, channel_id, function(err, tracks) {
        var trackCount = tracks.length,
            tracksWeighted = [];

        if (!trackCount) {
            console.log('Channel playlist empty!'.red);
            return;
        }

        for(n = 0; n < trackCount; n++) {
            var t = tracks[n],
                w = Math.ceil(t.weight);

            // Duplicate this track into tracksWeighted multiple times, based on weight
            for (i = 0; i < w; i++) {
                tracksWeighted.push(t.id);
            }
        }

        var track = tracksWeighted[Math.floor(Math.random() * tracksWeighted.length)];

        if (callback && typeof(callback) === "function") {
            callback(track);
        }
    });
}


Library.prototype.generateArtistBackground = function(artist) {
    var outputPath = path.resolve(__dirname, '../data/images', artist.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.png');
    if (fs.existsSync(outputPath)) return;

    // Create file to stop others
    var file = fs.createWriteStream(outputPath);

    lastFM.artist.getInfo({
        'artist' : artist
    }, function (err, response) {
        if (response) {
            var images = response.image;
            var image, n = 0;

            // Get the largest image
            for (n = images.length; n >= 0; n--) {
                if (images[n] && images[n].size) {
                    image = images[n]['#text'];
                    break;
                }
            }

            // If we've found an image download it
            if (image) {
                http.get(image, function (res) {
                    res.pipe(file);
                    file.on('finish', function() {
                        file.close(function() {
                            // Import image into LWIP
                            lwip.open(outputPath, 'png', function(err, image) {
                                if (err) {
                                    console.log('Open err: ' + err);
                                    return;
                                }

                                var h = (image.height() / image.width()) * 600;

                                // Add effects to image
                                image.batch()
                                     .saturate(-0.4)
                                     .darken(0.3)
                                     .resize(600, h)
                                     .writeFile(outputPath, function(err, buffer) {
                                        if (err) {
                                            console.log('Couldn\'t save image found for ' + artist);
                                        }
                                     });
                            });
                        });
                    });
                });
            } else {
                console.log('No artist image found for ' + artist);
            }

        } else if (err) {
            console.log(err);
        }
    });
}

// Subscribe to events
Library.prototype.watch = function(event, callback) {
    if (typeof this.watchers[event] === 'undefined') {
        this.watchers[event] = [];
    }
    this.watchers[event].push(callback);
}

// Emit events
Library.prototype.emit = function(event, data) {
    if (event in this.watchers && this.watchers[event].length) {
        for (i = 0; i < this.watchers[event].length; i++) {
            this.watchers[event][i](data);
        }
    }
}




module.exports = Library;