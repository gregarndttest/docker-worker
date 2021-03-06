var diskspace = require('diskspace');
var debug = require('debug')('taskcluster-docker-worker:diskspaceCheck');

export function exceedsDiskspaceThreshold(mnt, threshold, availableCapacity, log) {
  return new Promise(function (accept, reject) {
    diskspace.check(mnt, function (err, total, free, status) {
      var used = total-free;
      var capacity = (100*(used/total)).toPrecision(5);
      debug("%j", {
        volume: mnt,
        total: total,
        used: total - free,
        available: free,
        pctUsed: capacity,
      });

      // Always sure we have at last a minimum capacity when checking diskspace
      // threshold.  Not only does this provide some buffer, but also allow
      // diskspace to be cleaned up if currently running at max capacity.
      availableCapacity = Math.max(1, availableCapacity);
      var thresholdReached = free <= (threshold * availableCapacity);
      if (thresholdReached) {
        log('[alert-operator] diskspace threshold reached', {
          free: free,
          perTaskThreshold: threshold,
          availableWorkerCapacity: availableCapacity,
          totalthreshold: threshold * availableCapacity
        });
      }
      accept(thresholdReached);
    });
  });
}
