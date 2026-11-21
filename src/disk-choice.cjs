const { randomUUID } = require('node:crypto');

class DiskChoices {
  constructor(makeId = randomUUID) {
    this.makeId = makeId;
    this.items = new Map();
  }

  replace(disks) {
    this.items.clear();
    return disks.map((disk) => {
      const id = this.makeId();
      this.items.set(id, disk);
      return { id, label: disk.label };
    });
  }

  take(id) {
    if (typeof id !== 'string') return null;
    const disk = this.items.get(id);
    if (!disk) return null;
    this.items.delete(id);
    return disk;
  }

  clear() {
    this.items.clear();
  }
}

module.exports = { DiskChoices };
