var args = process.argv.slice(2);
if (args.length < 1) {
  args = ["config.toml"]
}

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

var configuration = null;
var routes = null;
var apps = null;
var auth = null;
var final = null;
var config = null;



var MongoDB = null;

var MongoDBstates = ["unknown", "dead", "live", "connecting", "lost"]
var MongoDBstate = "unknown";


function mongoCheck() {
    // console.log("mongoCheck", config.daemons.mongodb.MONGO_URL);
    if (MongoDB == null || MongoDBstate == "dead")
	MongoClient.connect(config.daemons.mongodb.MONGO_URL, function(err, db) {
	  if (db == null) {
	      console.log(config.daemons.mongodb.MONGO_URL, " failed to connect");
	      MongoDBstate = "dead";

              exec("/usr/local/bin/getMongoipaddress", function(error, stdout, stderr){ 
                  console.log("/usr/local/bin/getMongoipaddress", "error=", error, "stdout=", stdout, "stderr=", stderr); 
                    stdout = stdout.replace(/[ \t\n]/g,""); // remove whitespace
                    if (stdout && stdout.length > 5) {
                       config.daemons.mongodb.MONGO_URL =  config.daemons.mongodb.MONGO_URL.replace(/\/\/.*:/, "//" + stdout +":");
                       console.log("Found MongoDB IP address", config.daemons.mongodb.MONGO_URL);
                       MongoDBstate = "connecting";
                    }
              });
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
    // console.log("mongoCheck", MongoDBstate);
    if (MongoDBstate == "dead" || /* MongoDBstate == "connecting" || */ MongoDBstate == "lost")
	launchMongoDB();
    });
    return MongoDBstate;
}
// setInterval(mongoCheck, 5000);


/*
[daemons]
   [daemons.mongodb]
   MONGO_URL= "mongodb://localhost:27017/MedBook"
   cwd = "/"
   run = "/Users/tedgoldstein/Downloads/mongodb-osx-x86_64-2.6.10/bin/mongod"
   uid = "tedgoldstein"
*/

function launchMongoDB() {
 var cmd =  config.daemons.mongodb.run.split(" ");
 console.log("launch mongodb", cmd);
 var child = forever.start(cmd, {
     silent : true,
     fork: true,
     killTree: false,
     max: 1,
 });
}



function launch(app, res) {
 console.log("Gateway launching", app.route, app.cwd, app.run);
 var cmd =  app.run.split(" ");
 console.log("launch", cmd);
 var child = forever.start(cmd, {
     silent : true,
     fork: true,
     killTree: false,
     env: {
	PORT : app.port,
	ROUTE : app.route,
        MONGO_URL : config.daemons.mongodb.MONGO_URL,
     },
     cwd : app.cwd,
     max: 3,
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

  function forward(req, res) {
        var port = getPort(req);
        if (req.url.indexOf("/xena") == 0) {
            // console.log("xena directing to port", port, "mapping url", req.url, "to", req.url.replace("/xena","/"));
            req.url =  req.url.replace("/xena","");
        }
        proxy.web(req, res, {
          target: "http://localhost:"+port,
        },function(e){
          log_error(e,req);
	  console.log("web error", e);
	  launch(getApp(req), res);
	  res.writeHead(500, { 'Content-Type': 'text/html' });
          res.write(reloadFile, "binary");
	  res.end();
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

      function checkCredentials(cache, gateway_token) {
         if (gateway_token)
           try {
               var gateway_credentials = JSON.parse(gateway_token);
               var obj = JSON.parse(gateway_credentials.json);


               if ( obj.collaborations.indexOf(firstPart) >= 0) {

                   var signature = hash( gateway_credentials.json );
                   if ( signature == gateway_credentials.signature ) {
                       if (cache) console.log("credentials cached");
                       return true;
                   }
               }
           } catch (err) {
               console.log("credential failure" , err);
               console.log("gateway_token" , gateway_token);
               console.log("gateway_credentials" , gateway_credentials);
           }
         return false;
      }

      function requestCredentials() {
        var options = {
          method: 'GET',
          path: '/medbookUser',
          port: final,
          headers: { 'cookie': req.headers.cookie, },
          keepAlive: true,
          keepAliveMsecs: 3600000, // an hour
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
                   if (checkCredentials(false, gateway_token))
                       forward(req, res);
                   else
                       signIn(req, res);
               });
         });
        medbookUserReq.on("error", function(err) {
             signIn(req, res);
        });
        medbookUserReq.end();
      }; // requestCredentials()

      if (checkCredentials(true, cookies.get("gateway_token")))
         forward(req, res);
      else
         requestCredentials();
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
            console.log(".. not allowed: " + req.url);
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end();
	}
        return serveFile(req, res, '/data/home/galaxy/hexProxy/');
    }
    /*if (req.url.indexOf("/public") == 0)
        return serveFile(req, res, '/data/public/');*/
    

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
  var proxy = httpProxy.createProxy({ ws : true });



  server.on('upgrade',function(req,res){
    var port = getPort(req);
    proxy.ws(req, res, {
      target: "http://localhost:" + port,
    },function(e){
      log_error(e, req);
	launch(getApp(req));

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


configApp = function(path) {
  try {
    config = toml.parse(fs.readFileSync(path));
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

  function relaunch() {
       if (mongoCheck() == "LIVE") // if mongo is not live, don't bother checking anything else.
	   pingable.map(function(app) {
	       if (app.ping)
		   http.get("http://localhost:" + app.port + app.ping, function(res) {
		       console.log("Alive", app.route || app.daemon, " ping " + res.statusCode);
		   }).on('error', function(e) {
		       console.log("DEAD", app.route || app.daemon, " ping " + e.message);
		       launch(app, null);
		   });
	   });
  }

  if (parseInt(config.server.pingIntervalMS)) {
      console.log( "pinging every", config.server.pingIntervalMS);
      setInterval(relaunch, config.server.pingIntervalMS);
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

run();
