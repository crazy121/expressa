var jwt = require('jsonwebtoken');

// User document already validated, created, and saved to database
// The id of that document is given.
exports.doLogin = function(uid, req, res) {
	var token = jwt.sign(uid, req.settings.jwt_secret, {});
	res.send({
		token: token,
		uid: uid
	});
}

// Returns the user id, or false if not logged in.
exports.isLoggedIn = function(req, callback) {
	var token = req.query.token || req.headers['x-access-token']
	delete req.query.token
	if (token) {
		jwt.verify(token, req.settings.jwt_secret, function(err, decoded) {      
			if (err) {
				callback(false);
			} else {
				callback(decoded);
			}
		});
	} else {
		callback(false);
	}
}