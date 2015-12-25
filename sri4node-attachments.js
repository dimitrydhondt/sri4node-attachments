var s3 = require('s3');
var Q = require('q');
var qfs = require('q-io/fs');
var fs = require('fs');
var multer = require('multer');
var multerAutoReap = require('multer-autoreap');
multerAutoReap.options.reapOnError = true;
var useWinston = true;

function mergeObject(source, target) {
  'use strict';
  var key;
  for (key in source) {
    if (source.hasOwnProperty(key)) {
      target[key] = source[key];
    }
  }
}

exports = module.exports = {
  configure: function (winston, config) {
    'use strict';

    var diskstorage;
    var upload;

    // default configuration
    var configuration = {
      s3key: '',
      s3secret: '',
      s3bucket: '',
      s3region: 'eu-west-1',
      maximumFilesizeInMB: 10,
      tempFolder: process.env.TMP ? process.env.TMP : '/tmp', // eslint-disable-line
      folder: '/tmp'
    };
    mergeObject(config, configuration);

    // Use disk storage, limit to 5 files of max X Mb each.
    // Avoids DoS attacks, or other service unavailability.
    // Files are streamed from network -> temporary disk files.
    // This requires virtually no memory on the server.
    diskstorage = multer.diskStorage({
      destination: configuration.tempFolder
    });

    upload = multer({
      storage: diskstorage,
      limits: {
        fieldNameSize: 256,
        fieldSize: 1024,
        fields: 5,
        fileSize: configuration.maximumFilesizeInMB * 1024 * 1024,
        files: 5,
        parts: 10,
        headerPairs: 100
      }
    });

    function warn(x) {
      if (!useWinston) {
        console.log(x); // eslint-disable-line
      } else {
        winston.log('warn', x);
      }
    }

    function error(x) {
      if (!useWinston) {
        console.log(x); // eslint-disable-line
      } else {
        winston.log('error', x);
      }
    }

    function debug(x) {
      if (!useWinston) {
        console.log(x); // eslint-disable-line
      } else {
        winston.log('debug', x);
      }
    }

    function createS3Client() {
      var s3key = configuration.s3key; // eslint-disable-line
      var s3secret = configuration.s3secret; // eslint-disable-line

      if (s3key && s3secret) {
        return s3.createClient({
          maxAsyncS3: 20,
          s3RetryCount: 3,
          s3RetryDelay: 1000,
          multipartUploadThreshold: (configuration.maximumFilesizeInMB + 1) * 1024 * 1024,
          multipartUploadSize: configuration.maximumFilesizeInMB * 1024 * 1024, // this is the default (15 MB)
          s3Options: {
            accessKeyId: s3key,
            secretAccessKey: s3secret,
            region: configuration.s3region
          }
        });
      }

      return null;
    }

    function uploadToS3(s3client, fromFilename, toFilename) {
      var deferred = Q.defer();
      var msg, params;
      var s3bucket = configuration.s3bucket; // eslint-disable-line

      params = {
        localFile: fromFilename,
        s3Params: {
          Bucket: s3bucket,
          Key: toFilename
        }
      };

      var uploader = s3client.uploadFile(params);

      uploader.on('error', function (err) {
        msg = 'All attempts to uploads failed!';
        error(msg);
        error(err);
        error(err.stack);
        deferred.reject(msg);
      });
      uploader.on('end', function () {
        debug('Upload of file [' + fromFilename + '] was successful.');
        deferred.resolve();
      });

      return deferred.promise;
    }

    function downloadFromS3(s3client, response, filename) {
      var s3bucket = configuration.s3bucket;
      var stream, msg;

      var params = {
        Bucket: s3bucket,
        Key: filename
      };
      stream = s3client.downloadStream(params);
      stream.pipe(response);
      stream.on('error', function (err) {
        msg = 'All attempts to download failed!';
        error(msg);
        error(err);
        error(err.stack);
        response.sendStatus(500);
      });
    }

    function handleFileUpload(req, res) {
      var path = configuration.folder;
      var s3client = createS3Client();
      var i;
      var fromFilename;
      var toFilename;
      var promises = [];

      debug('handling file upload !');
      debug(req.files);

      if (s3client) {
        for (i = 0; i < req.files.length; i++) {
          fromFilename = req.files[i].path;
          toFilename = req.params.key + '-' + req.params.filename;
          promises.push(uploadToS3(s3client, fromFilename, toFilename));
        }
      } else {
        warn('Sending files to temporary storage. SHOULD NOT BE USED IN PRODUCTION !');
        for (i = 0; i < req.files.length; i++) {
          fromFilename = req.files[i].path;
          toFilename = path + '/' + req.params.key + '-' + req.params.filename;
          promises.push(qfs.copy(fromFilename, toFilename));
        }
      }
      Q.all(promises).then(function () {
        // Acknowledge to the client that the files were stored.
        res.sendStatus(201);
      }).catch(function (err) {
        error('Unable to upload all files...');
        error(err);
        error(err.stack);
        // Notify the client that a problem occured.
        res.sendStatus(500);
      });
    }

    function handleFileDownload(req, res) {
      var path = configuration.folder;
      var s3client = createS3Client(configuration);
      var remoteFilename;
      var localFilename;

      debug('handling file download !');
      if (s3client) {
        remoteFilename = req.params.key + '-' + req.params.filename;
        downloadFromS3(s3client, res, remoteFilename);
      } else {
        warn('Reading files from temporary storage. SHOULD NOT BE USED IN PRODUCTION !');
        localFilename = path + '/' + req.params.key + '-' + req.params.filename;
        // TODO : Store meta-information like content-type in a second file on disk.
        res.setHeader('content-type', 'image/png');
        fs.createReadStream(localFilename).pipe(res);
      }
    }

    return {
      customRouteForUpload: function (type, extraMiddleware) {
        var allMiddleware = [
            multerAutoReap,
            upload.any()
        ];
        if (extraMiddleware) {
          allMiddleware = allMiddleware.concat(extraMiddleware);
        }

        return {
          route: type + '/:key/:filename',
          method: 'PUT',
          middleware: allMiddleware,
          handler: handleFileUpload
        };
      },

      customRouteForDownload: function (type, extraMiddleware) {
        return {
          route: type + '/:key/:filename',
          method: 'GET',
          middleware: extraMiddleware,
          handler: handleFileDownload
        };
      }
    };
  }
};