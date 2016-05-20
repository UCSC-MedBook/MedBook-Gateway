var args = process.argv.slice(2);
if (args.length < 1) {
  args = ["config.toml"]
}

var _ = require('underscore');

var Cookies = require('cookies');
var toml = require('toml');
var fs = require('fs');


var url = require('url');
var path = require('path');
var http = require('http');

var crypto = require('crypto');
var randomstring = require("randomstring");
var forever = require('forever-monitor');
var MongoClient = require('mongodb').MongoClient;

var exec = require('child_process').exec;

require( "console-stamp" )( console, { pattern : "dd/mm/yyyy HH:MM:ss.l" } );

var configuration = null;
var routes = null;
var apps = null;
var auth = null;
var final = null;
var config = null;



var MongoDB = null;

var MongoDBstates = ["unknown", "dead", "live", "connecting", "lost"]
var MongoDBstate = "unknown";


function getMongoipaddress(callBack) {
  exec("/usr/local/bin/getMongoipaddress", function(error, stdout, stderr){ 
      console.log("/usr/local/bin/getMongoipaddress", "error=", error, "stdout=", stdout, "stderr=", stderr); 
        stdout = stdout.replace(/[ \t\n]/g,""); // remove whitespace
        if (stdout && stdout.length > 5) {
           config.daemons.mongodb.MONGO_URL =  config.daemons.mongodb.MONGO_URL.replace(/\/\/.*:/, "//" + stdout +":");
           console.log("Found MongoDB IP address", config.daemons.mongodb.MONGO_URL);
           MongoDBstate = "connecting";
           if (callBack)
              callBack(config.daemons.mongodb.MONGO_URL);
        }
  });
}
function mongoCheck() {
    // console.log("mongoCheck", config.daemons.mongodb.MONGO_URL);
    if (MongoDB == null || MongoDBstate == "dead")
	MongoClient.connect(config.daemons.mongodb.MONGO_URL, function(err, db) {
	  if (db == null) {
	      console.log(config.daemons.mongodb.MONGO_URL, " failed to connect");
	      MongoDBstate = "dead";

	  } else {
	      MongoDB = db;
	      MongoDBstate = "connecting";
	  }
	}) 
      else MongoDB.admin().ping(function(err, pingResult) {
	  if (pingResult && pingResult.ok == 1)
	      MongoDBstate = "live";
	  else {
	      MongoDBstate = "lost";
	  }
          /*
          console.log("mongoCheck", MongoDBstate);
          if (MongoDBstate == "dead" || MongoDBstate == "lost")
    	      launchMongoDB();
           */
        });
    return MongoDBstate;
}


/*
[daemons]
   [daemons.mongodb]
   MONGO_URL= "mongodb://localhost:27017/MedBook"
   cwd = "/"
   run = "/Users/tedgoldstein/Downloads/mongodb-osx-x86_64-2.6.10/bin/mongod"
   uid = "tedgoldstein"

function launchMongoDB() {
 var cmd =  config.daemons.mongodb.run.split(" ");
 console.log("launch mongodb", cmd);
 var child = forever.start(cmd, {
     uid: "mongodb",
     silent : true,
     fork: true,
     killTree: false,
 });
}
*/

MinimumLaunchInterval = 30000; // 30 seconds


function launch(app, req, res) {
     var now = new Date();
     if (app.lastStart != null && ((now - app.lastStart) <= MinimumLaunchInterval)) {
         console.log("Gateway too soon to launch", app.route, (now  - app.lastStart));
         return
     }
     app.lastStart = now;
     console.log("Gateway launching", app.route, app.cwd, app.run, config && config.daemons && config.daemons.mongodb && config.daemons.mongodb.MONGO_URL);

     var cmd = app.run;

     if (process.getuid() == 0) cmd = "su galaxy -c " + cmd;
     cmd = cmd.split(" ");
     console.log("launch", cmd);

     var logs = '/data/MedBook/Gateway/logs' + app.route;
     var env = {
            HOME:  "/data/home/galaxy",
            SHELL: "/bin/bash",
            USER: "galaxy",
            LOGNAME: "galaxy",

            // for CbioPortal
            CATALINA_HOME: "/usr/local/tomcat7",
            CLASSPATH: "/usr/local/tomcat7/bin/bootstrap.jar:/usr/local/tomcat7/bin/tomcat-juli.jar",
            JAVA_HOME: "/usr/lib/jvm/java-1.7.0-openjdk.x86_64",
            BASEDIR: "/usr/local/tomcat7",
            PORTAL_HOME: "/data/home/galaxy/src/cbioportal.org",
            NODE_PATH:"/usr/local/lib/node_modules:$NODE_PATH",

            // For ingesting data
            MEDBOOK_APP_DIR: app.cwd,
            MEDBOOK_APP_DATA: app.data ? app.data : app.cwd + "/data",

            // This should be much less and pared down to the essentials.
            PATH: "/data/home/galaxy/.local/bin:/data/packages/stuartlab/perl/Tools:/data/packages/py-lib/:/usr/lib64/qt-3.3/bin:/usr/local/bin/mongodb/bin:/data/packages/drl-graph-layout/bin:/data/packages/apache-maven-3.0.4/bin:/usr/local/bin:/bin:/usr/bin:/usr/local/sbin:/usr/sbin:/sbin:/data/home/galaxy/bin:/data/packages/stuartlab/perl/Tools:/data/packages/py-lib/:/usr/local/apache-maven-3.2.2/bin",

            PORT : app.port,
            ROUTE : app.route,
            MONGO_URL : config.daemons.mongodb.MONGO_URL,
            HOST : config.server.host,
            ROOT_URL: (config.server.ssl  ? "https://" : "http://") + config.server.host + app.route
         };

     var envFile = JSON.parse(fs.readFileSync("/data/MedBook/Gateway/DONOTCHECKINTOGIT.json", "utf8"))
     _.extend(env, envFile);

     var child = forever.start(cmd, {
         silent : true,
         fork: true,
         killTree: false,
         pidFile: './pidFile',

         logFile: logs + '.log', // Path to log output from forever process (when daemonized)
         outFile: logs + '.out', // Path to log output from child stdout
         errFile: logs + '.err', // Path to log output from child stderr

         env: env,
         cwd : app.cwd,
         max: 1,
     });

     child.on('forever watch:restart', function(info) {
         if (res) res.write('Restaring script because ' + info.file + ' changed');
         console.error('Restaring script because ' + info.file + ' changed');
     });

     child.on('forever restart', function() {
         if (res) res.write('Forever restarting script for ' + child.times + ' time');
         console.error('Forever restarting script for ' + child.times + ' time');
     });

     child.on('forever exit:code', function(code) {
         if (res) res.write('Forever detected script exited with code ' + code);
         console.error('Forever detected script exited with code ' + code);
     });
}


var SECRET;
function changeSecret() {
    SECRET = randomstring.generate(7);
}
changeSecret();

setInterval(changeSecret, 30000);

function hash(pwd) {
    var hash = crypto.createHash('sha256').update(SECRET + pwd).digest('base64');
    return hash;
}

var server = null;

menuFile = null;
reloadFile = null;
postScript = null;

function fixGalaxyOwner(run) {
    var fgo = "/data/MedBook/.fix-galaxy-owner"; // This file itself won't be fixed. An exericise to the reader to see why.
    if (!fs.existsSync(fgo)) {
        var exec = require('child_process').exec, child;
        fs.writeFileSync(fgo, "started\n", "utf8")
        child = exec('chown -R galaxy /data/home/galaxy/.meteor  /data/MedBook',
              function (error, stdout, stderr) {
                  console.log('chown stdout: ' + stdout);
                  console.log('chown stderr: ' + stderr);
                  if (error !== null) {
                        console.log('chown exec error: ' + error);
                  } 
                  fs.writeFileSync(fgo, "finished\nstdout:" + stdout + "\nstderr:" + stderr, "utf8");
               });

    } 
} 

getPort = function(req) {
    var a = req.url.split("/");
    if (a.length > 1) {
        var p = routes["/" + a[1]];
        if (p) {
            // console.log("getPort", req.url, p);
            return p;
        }
    }
    // console.log("getPort final", req.url, final);
    return final;
}

getApp = function(req) {
    var a = req.url.split("/");
    if (a.length > 1) {
        var p = apps["/" + a[1]];
        if (p) {
            return p;
        }
    }
    return config.final;
}


readMenu = function() {
  menuFile = fs.readFileSync("/data/MedBook/Gateway/menu.html");
  reloadFile = fs.readFileSync("/data/MedBook/Gateway/reload.html");
};

readMenu();


postScriptFilename = "/data/MedBook/Gateway/postScript.js";
readPostScript = function() {
  postScript = fs.readFileSync(postScriptFilename);
};
readPostScript();


redirectServer = null;
readSSLcredentials = function() {
    if (config.server.ssl && config.server.nonssl)  {
      if (redirectServer)
          server.close();

      redirectServer = require('http').createServer(function(req, res) {
       var hostname = req.headers.host
       

       // redirect http://tumormap.ucsc.edu to https://medbook.ucsc.edu/hex  (change hex to tumormap later)
        if (hostname && hostname.indexOf("tumormap") == 0 ) {
            var red = "https://" + config.server.host + ":" + config.server.ssl + "/hex" + req.url;
            res.writeHead(307, {'Location': red});
            res.end();
        } else {
           var red = "https://" + config.server.host + ":" + config.server.ssl + req.url;
           res.writeHead(307, {'Location': red});
           res.end();
        }

      });
      redirectServer.listen(config.server.nonssl);
    }

    var options = {
         key: fs.readFileSync(config.server.key),
         cert: fs.readFileSync(config.server.cert),
    };

    if (config.server.chain) {
        var ca = []
        var chain = fs.readFileSync(config.server.chain, 'utf8');
        chain = chain.split("\n");
        var cert = [];
        for (var i =0; i < chain.length; i++) {
          var line = chain[i];
          if (line.length > 0) {
            cert.push(line);
            if (line.match(/-END CERTIFICATE-/)) {
                var c = cert.join("\n");
                ca.push(c);
                cert = [];
            }
          }
        }
        options.ca = ca;
    }
    return options;
}

run = function() {
  if (server) {
    server.close();
  }

  configApp(args[0]);
  mongoCheck();

  function forward(req, res) {

      if (req.url.indexOf("/proj") == 0) {
        // console.log("xenafiling");
        proxy.web(req, res, {
          target: "https://genome-cancer.soe.ucsc.edu/" ,
          timeout: 7*24*60*60*1000
          /*
          xfwd: true,
          toProxy: true,
          prependPath: true,
          */
        },function(e){
          console.log("xena app error", req.url, e.code);
        });
        return;
      } // if xena

      var app = getApp(req);
      var port = getPort(req);

      var origReqUrl = req.url;

      var protocol = "http";
      if (req.protocol)
            protocol = req.protocol;

      var host = "localhost";
      if (app.host)
            host = app.host;

      var target = protocol+"://"+host+":"+port;


      if (false && req.url.indexOf("/xena") == 0) {
            req.url =  req.url.replace("/xena","/proj/site/xena");
            /*
            if (req.url.length == 0)
                req.url = "/";
                */
            req.client.servername = "su2c-dev.ucsc.edu";
            req.host = "su2c-dev.ucsc.edu";
            req.headers.host = "su2c-dev.ucsc.edu";
            // console.log("xena redirecting to", target, "mapping ", origReqUrl, "to", req.url, req);
      } // if xena
        //console.log("mapping", origReqUrl, target, req.url);
        proxy.web(req, res, {
          target: target,
          timeout: 7*24*60*60*1000
      },function(e){
          console.log("app error", origReqUrl, target, e.code);

          if (app.run && app.cwd) {
  
              ping(app, req, res);
              /*
              res.writeHead(500, { 'Content-Type': 'text/html' });
              res.write(reloadFile, "binary");
              res.end();
              */
          } 
      });
  }

  function signIn(req, res) {
      var host = null;
      if (config.server.ssl)
        host = "https://" + config.server.host + ":"+ config.server.ssl;
      else
        host = "http://" + config.server.host + ":"+ config.server.nonssl;

      var url = host + "/sign-in?RETURNTO="+encodeURI(req.url);
      res.writeHead(307, { location: url});
      res.end();
  }

  function mustLogin(firstPart, req, res) {
      var cookies = new Cookies(req, res);

      // console.log("ml 1");

      function checkCredentials(cache, gateway_token) {
         if (gateway_token)
           try {
          // console.log("cc 2");
               var gateway_credentials = JSON.parse(gateway_token);
               var obj = JSON.parse(gateway_credentials.json);
               // console.log("check", obj, firstPart);


               if ( obj.collaborations.indexOf(firstPart) >= 0) {

                   var signature = hash( gateway_credentials.json );
                   if ( signature == gateway_credentials.signature ) {
                       // if (cache) console.log("credentials cached");
                       return true;
                   }
               }
           } catch (err) {
               // console.log("credential failure" , err);
               // console.log("gateway_token" , gateway_token);
               // console.log("gateway_credentials" , gateway_credentials);
           }
         return false;
      }

      function requestCredentials() {
        var options = {
          method: 'GET',
          host: "127.0.0.1",
          path: '/medbookUser',
          port: 10001,
          headers: { 'Cookie': req.headers.cookie, },
          keepAlive: true,
          keepAliveMsecs: 100, // an hour
         };
         var medbookUserReq = http.request(options, function(medbookUserRes) {
               medbookUserRes.setEncoding('utf8');
               var all = "";
               medbookUserRes.on("data", function(data) { all += data; });
               medbookUserRes.on("end", function(data) {
                   if (data != null) all += data;
                   var gateway_credentials = { signature: hash( all ), json: all, }
                   var gateway_token = JSON.stringify(gateway_credentials);
                   cookies.set("gateway_token", gateway_token);
                   if (checkCredentials(false, gateway_token)) {
                      // console.log("credentials verify");
                       forward(req, res);
                   } else {
                      // console.log("credentials fail");
                       signIn(req, res);
                   }
               });
         });
        medbookUserReq.on("error", function(err) {
           // console.log("error on request 4, please signIn", err);
             signIn(req, res);
        });
        medbookUserReq.end();
      }; // requestCredentials()

          // console.log("rc 6");
      if (checkCredentials(true, cookies.get("gateway_token"))) {
         // console.log("rc 7");
         forward(req, res);
      } else {
         // console.log("rc 8");
         requestCredentials();
      }
      // console.log("rc 9");
  } // mustLogin


  function main(req, res) {
    var hostname = req.headers.host
    if (req.url == "/menu")
        return serveMenu(req, res);
    if (req.url.indexOf( "/postScript") == 0)
        return serveScript(req, res, postScript);
    
    if (req.url.indexOf(hostname.indexOf("tumormap")) == 0 ) {
        var red = "https://" + config.server.host + ":" + config.server.ssl + "/hex/" + req.url;
        res.writeHead(307, {'Location': red});
        res.end();
    }
    if (req.url.indexOf("/swat") == 0 ) {
        req.url = req.url.replace("/swat", "");
 	if (req.url.indexOf("/..") >=0 ) {
            // console.log(".. not allowed: " + req.url);
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end();
	}
        return serveFile(req, res, '/data/home/galaxy/hexProxy/');
    }
    if (req.url.indexOf("/serve") == 0)
        return serveFile(req, res, '/data/serve/');
    

    var urlPath = req.url.split("/");
    var firstPart = "never match";
    if (urlPath && urlPath.length >= 2 && urlPath[1].length > 0)
        firstPart = urlPath[1];

    var sla = "/" + firstPart;

    if (sla in auth && auth[sla]) {
        mustLogin(firstPart, req, res);
    } else
        forward(req, res);
  } // main

  if (config.server.ssl)
      server = require('https').createServer(readSSLcredentials(), main);
  else
      server = require('http').createServer(main);

  var httpProxy = require('http-proxy')
  var proxy = httpProxy.createProxy({ ws : true, xfwd : true });



  server.on('upgrade',function(req,res){
    var port = getPort(req);
    proxy.ws(req, res, {
      target: "http://localhost:" + port,
    },function(e){
      log_error(e, req);
	launch(getApp(req), req, res);

	console.log("WS ERROR", e);
	/*
	res.writeHead(500, {
	  'Content-Type': 'text/plain'
	});
	res.end('Something went wrong. And we are reporting a custom error message.');
	*/
    });
  })
   
  if (config.server.ssl) {
      console.log("ssl listening on", config.server.ssl);
      server.listen(config.server.ssl)
  } else {
      console.log("nonssl listening on", config.server.nonssl);
      server.listen(config.server.nonssl)
  }


};

splitHostPort = function(s) {
  var parts, ret;
  parts = s.split(':', 2);
  ret = {
    host: parts[0]
  };
  if (parts.length > 1) {
    ret.port = parseInt(parts[1], 10);
  } else {
    ret.port = 80;
  }
  return ret;
};

function ping(app, req, res) {
   if (app.ping) {
       var url = "http://localhost:" + app.port + app.ping;
       // console.log("ping", app.route || app.daemon, url);
       http.get(url, function(res) {
           // console.log("ALIVE", app.route || app.daemon, url);
       }).on('error', function(e) {
           console.log("DEAD", app.route || app.daemon, url, e.message);
           launch(app, req, res);
       });
   }
}


configApp = function(path) {
  try {
    config = toml.parse(fs.readFileSync(path));
    // console.log("reading config", config);
  } catch (_error) {
    console.log("Failed to parse configuration file " + path);
    return process.exit(1);
  }

  var appName, ca, link, menu, menuItem;
  menu = [];
  routes = {};
  apps = {};
  auth = {};
  final = config.final.port
  pingable = [];

  for (appName in config.apps) {
    var ca = config.apps[appName];
    routes[ca.route] = ca.port;
    apps[ca.route] = ca;
    if (ca.ping)
	pingable.push(ca)
    auth[ca.route] = ca.auth;
  }

function autostart() {
   // console.log("autostart 1");
       // console.log("autostart 2");
       pingable.map(function(app) {
           // console.log("autostart 3");
           ping(app, null, null);
       });
}

if (parseInt(config.server.pingIntervalMS)) {
  console.log( "pinging every", config.server.pingIntervalMS);
  setInterval(autostart, config.server.pingIntervalMS);
}
};

serveMenu = function(req, res) {
var menu = [];
var routeHacks = "";
for (appName in config.apps) {
var ca = config.apps[appName];
menuItem = String(ca.menuItem);
if (menuItem === null) {
  menuItem = ca.route;
}
menuItem = menuItem.replace(/\ /g, "&nbsp;");
href = ca.path ? ca.path : ca.route;

link = "<a target='_self' class='MedBookLink' href='" + href  + "'>" + menuItem + "</a>";
routeHacks += "if (Router && !('" + ca.route + "' in  Router.routes)) Router.route('" + ca.route + "', function () {}, {where: 'server'});\n";
if (ca.menuItem) {
  if (ca.menuPosition !== void 0) {
    menu.splice(ca.menuPosition, 0, link);
  } else {
    menu.push(link);
  }
}
}

var text = String(menuFile).replace("LIST", (menu.map(function(a) {
return "<li>" + a + "</li><br/>";
})).join(''));

text += "<script>if (Router) {\n" + routeHacks + "}\n</script>";


res.writeHead(200);
res.write(text, "binary");
return res.end();
};

serveScript = function(req, res, script) {
res.writeHead(200, {'Content-Type': 'application/x-javascript'});
res.write(script, "binary");
return res.end();
};


var mimeTypes = {
"html": "text/html",
"jpeg": "image/jpeg",
"jpg": "image/jpeg",
"png": "image/png",
"js": "text/javascript",
"css": "text/css"};

    
function serveFile(req, res, dir) {
var uri = url.parse(req.url).pathname;
// console.log("serveFile uri", uri);
if (uri == null || uri == "" || uri == "/")
   uri = "index.html"
var filename = path.join(dir, uri);
fs.exists(filename, function(exists) {
    if(!exists) {
        console.log("not exists: " + filename);
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end();
        return;
    }
    var mimeType = mimeTypes[path.extname(filename).split(".")[1]];
    res.writeHead(200, mimeType);

    var fileStream = fs.createReadStream(filename);
    fileStream.pipe(res);

}); //end fs.exists

};

console.log("watching", args[0]);

fs.watchFile(args[0], run);
fs.watchFile("/data/MedBook/Gateway/menu.html", readMenu);
fs.watchFile(postScriptFilename, readPostScript);

function log_error(e,req){
if(e){
/*
console.log("log_error");
console.error(e.message);
console.log(req.headers.host,'-->');
console.log('-----');
*/
}
}

// fixGalaxyOwner();
run();
