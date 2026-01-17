// ADD THESE ROUTES TO YOUR server.js (after the existing routes)

// ==========================================
// EMAIL MANAGEMENT API ROUTES
// ==========================================

// Get all process owners with their directives
app.get('/api/process-owners-with-directives', async (req, res) => {
  try {
    const directives = await Directive.find().sort({ owner: 1, createdAt: -1 });
    
    // Group by owner
    const ownerMap = new Map();
    
    directives.forEach(directive => {
      const ownerName = directive.owner || 'Unassigned';
      
      if (!ownerMap.has(ownerName)) {
        ownerMap.set(ownerName, {
          name: ownerName,
          primaryEmail: directive.primaryEmail || '',
          secondaryEmail: directive.secondaryEmail || '',
          directiveCount: 0,
          directives: []
        });
      }
      
      const owner = ownerMap.get(ownerName);
      owner.directiveCount++;
      owner.directives.push({
        _id: directive._id,
        ref: directive.ref,
        subject: directive.subject,
        source: directive.source,
        monitoringStatus: directive.monitoringStatus
      });
    });
    
    // Convert map to array and sort
    const owners = Array.from(ownerMap.values()).sort((a, b) => {
      // Sort: without email first, then by name
      const aHasEmail = a.primaryEmail && a.primaryEmail.trim() !== '';
      const bHasEmail = b.primaryEmail && b.primaryEmail.trim() !== '';
      
      if (aHasEmail === bHasEmail) {
        return a.name.localeCompare(b.name);
      }
      return aHasEmail ? 1 : -1;
    });
    
    res.json({ success: true, data: owners });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update emails for all directives of a specific owner
app.post('/api/update-owner-emails', async (req, res) => {
  try {
    const { owner, primaryEmail, secondaryEmail } = req.body;
    
    if (!owner) {
      return res.status(400).json({ success: false, error: 'Owner name required' });
    }
    
    // Update all directives for this owner
    const result = await Directive.updateMany(
      { owner: owner },
      {
        $set: {
          primaryEmail: primaryEmail || '',
          secondaryEmail: secondaryEmail || ''
        }
      }
    );
    
    res.json({ 
      success: true, 
      updated: result.modifiedCount,
      message: `Updated ${result.modifiedCount} directives for ${owner}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

