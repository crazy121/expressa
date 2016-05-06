var express = require('express')
var router = express.Router()
var bodyParser  = require('body-parser')
var auth = require('./auth')
var mongoQuery = require('mongo-query');
var MongoQS = require('mongo-querystring');

var rolePermissions = require('./role_permissions')(router);

var dbTypes = {
	file: require('./db/file'),
	postgres: require('./db/postgres'),
	mongo: require('./db/mongo'),
}
router.dbTypes = dbTypes

var db = {}
db.settings = dbTypes['file']({}, 'settings')
router.db = db

router.settings = {}
db.settings.findOne('production')
	.then(function(data) {
		router.settings = data;

		db.collection = dbTypes[router.settings.collection_db_type||'file'](router.settings, 'collection')

		return db.collection.all()
			.then(function(result) {
				result.forEach(function(collection) {
					db[collection._id] = dbTypes[collection.storage](router.settings, collection._id);
					db[collection._id].init();
				});
				console.log('collections loaded.')
			}, function(err) {
				console.error('failed to load collections');
				console.error(err);
			});
	}, function(err) {
		console.error('error reading settings')
		console.error(err.stack)
	})
	.then(function(data) {
		// Add standard collection based permissions
		require('./collection_permissions')(router)

		require('./listeners')(router)

		require('./validation_listeners')(router)
	})

var eventListeners = {};
router.eventListeners = eventListeners;

router.addListener = function addListener(events, priority, listener) {
	if (typeof events == 'string') {
		events = [events];
	}
	if (typeof priority == 'function') {
		listener = priority;
		priority = 0;
	}
	listener.priority = priority;
	events.forEach(function(event) {
		eventListeners[event] = eventListeners[event] || [];
		eventListeners[event].push(listener);
		eventListeners[event].sort(function(a,b) {
			return a.priority - b.priority
		})
	})
}

// The wildcard type ensures it works without the application/json header
router.use(bodyParser.json({ type: "*/*" }))

router.use(function(req, res, next) {
	req.settings = router.settings;
	next()
})

router.post('/user/register', auth.getRegisterRoute(router))
router.post('/user/login', auth.getLoginRoute(router))

router.use(auth.middleware) // Add user id to request, if logged in
router.use(rolePermissions.middleware) // Add user and permissions to request

router.get('/user/me', function(req, res, next) {
	req.params.collection = 'users';
	req.params.id = req.uid;
	getById(req, res, next);
	//res.redirect('/users/' + req.uid)
});

function notify(event, req, collection, data) {
	if (typeof eventListeners[event] == 'undefined' || eventListeners[event].length == 0) {
		return Promise.resolve(true);
	}
	console.log('notifying '+ eventListeners[event].length +  ' of ' + event)
	var promises = eventListeners[event].map(function(listener) {
		//console.log('calling ' + listener.name)
		return listener(req, collection, data)
	})
	return Promise.all(promises)
		.then(function(results) {
			console.log('notifying done')
			// Result is the first defined value
			var result = results.reduce(function(prev, current) {
				return (prev == undefined) ? current : prev;
			})
			return result || result === undefined
		}, function(err) {
			console.error('ERROR during listeners')
			console.error(err);
			return err;
		});	
}

router.get('/:collection/schema', function (req, res, next) {
	db.collection.findOne(req.params.collection)
		.then(function(collection) {
			notify('get', req, 'schemas', collection.schema)
				.then(function(allow) {
					if (allow)
						res.send(collection.schema);
					else 
						res.status(403).send('forbidden')
				}, function(err) {
					next(err)
				})

		}, function(err, code) {
			res.errCode = code;
			next(err);
		})
})

router.get('/:collection', function (req, res, next) {
	if (typeof db[req.params.collection] == 'undefined') {
		return res.status(404).send('page not found')
	}
	if (Object.keys(req.query).length > 0) {
		var query;
		if (typeof req.query.query != 'undefined') {
			query = JSON.parse(req.query.query)
		} else {
			var params = JSON.parse(JSON.stringify(req.query));
			delete params['skip']
			delete params['offset']
			delete params['limit']
			query = MongoQS.parse(params)
		}
		if (req.query.skip) {
			req.query.skip = parseInt(req.query.skip)
		}
		if (req.query.offset) {
			req.query.offset = parseInt(req.query.offset)
		}
		if (req.query.limit) {
			req.query.limit = parseInt(req.query.limit)
		}
		db[req.params.collection].find(query, req.query.skip || req.query.offset, req.query.limit)
			.then(function(data) {
				var promises = data.map(function(doc) {
					return notify('get', req, req.params.collection, doc);
				});
				Promise.all(promises)
					.then(function(allowed) {
						res.send(data.filter(function(doc, i) {
							return allowed[i];
						}))
					}, function(err) {
						next(err);
					})
			}, function(err, code) {
				res.errCode = code;
				next(err);
			});
	} else {
		db[req.params.collection].all()
			.then(function(data) {
				var promises = data.map(function(doc) {
					return notify('get', req, req.params.collection, doc);
				});
				Promise.all(promises)
					.then(function(allowed) {
						res.send(data.filter(function(doc, i) {
							return allowed[i];
						}))
					}, function(err) {
						next(err);
					})
			}, function(err, code) {
				res.errCode = code;
				next(err);
			});
	}
})

router.post('/:collection', function (req, res, next) {
	var data = req.body
	notify('post', req, req.params.collection, data)
		.then(function(allowed) {
			if (allowed == true) {
				db[req.params.collection].create(data)
					.then(function(id) {
						notify('changed', req, req.params.collection, data)
						res.send({
							status: 'OK',
							id: id
						});
					}, function(err, code) {
						res.errCode = code;
						next(err);
					});
			} else {
				res.status(allowed.code||500).send(allowed.message);
			}
		}, function(err) {
			next(err)
		});
})

function getById(req, res, next) {
	if (req.params.id == 'schema')
		return next();
	db[req.params.collection].findOne(req.params.id)
		.then(function(data) {
			notify('get', req, req.params.collection, data)
				.then(function(allowed) {
					if (allowed == true) {
						res.send(data);
					} else {
						res.status(allowed.code||500).send(allowed.message || 'forbidden');
					}
				});
		}, function(err, code) {
			res.errCode = code;
			next(err);
		});
}
router.get('/:collection/:id', getById)

router.put('/:collection/:id', function(req, res, next) {
	var data = req.body
	data._id = req.params.id
	notify('put', req, req.params.collection, data)
		.then(function(allowed) {
			if (allowed == true) {
				db[req.params.collection].update(req.params.id, req.body)
					.then(function(data) {
						notify('changed', req, req.params.collection, req.body)
						res.send('OK');
					}, function(err, code) {
						res.errCode = code;
						next(err);
					});
			} else {
				res.status(allowed.code||500).send(allowed.message || 'forbidden');
			}
		}, function(err) {
			next(err);
		})
})

router.post('/:collection/:id/update', function (req, res, next) {
	var modifier = req.body

	db[req.params.collection].findOne(req.params.id)
		.then(function(doc) {
			var changes = mongoQuery(doc, {}, modifier);
			req.body = doc;
			db[req.params.collection].update(req.params.id, req.body)
				.then(function(data) {
					notify('changed', req, req.params.collection, req.body)
					res.send(doc);
				}, function(err, code) {
					res.errCode = code;
					next(err);
				});
		});
})

router.delete('/:collection/:id', function (req, res, next) {
	notify('delete', req, req.params.collection, {_id: req.params.id})
		.then(function(allow) {
			if (allow) {
				db[req.params.collection].destroy(req.params.id)
					.then(function(data) {
						res.send('OK');
					}, function(err, code) {
						res.errCode = code;
						next(err); 
					});
			}
			else {
				res.status(403).send('forbidden')
			}
		}, function(err) {
			next(err)
		})
})

// Error handler, log and send to user
router.use(function(err, req, res, next) {
	console.log('my err handler')
	console.error(err.stack);
	res.status(res.errCode || 500)
	if (req.hasPermission('view: errors')) {
		res.send(err);
	} else {
		res.send('something wrong happened')
	}
})

module.exports = router;