/**
Middleware for using the simple "ghetto" buffer
*/

var GhettoStream = require('../ghetto_stream');
function BufferLog() {
  var stream = new GhettoStream();

  return {
    start: function(task, dockerProcess) {
      dockerProcess.stdout.pipe(stream);
    },

    end: function(output) {
      // stream as text output for our alpha version
      output.extra_info = {
        log: stream.text
      };
      return output;
    }
  };
}

module.exports = BufferLog;
