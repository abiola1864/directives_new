// ADD THIS TO YOUR server.js after the existing routes

// ==========================================
// SUBMISSION PORTAL ROUTES
// ==========================================

// Serve submission page
app.get('/submit-update/:id', (req, res) => {
  res.sendFile(__dirname + '/public/submit-update.html');
});

// Handle submission with file uploads (without file storage for now)
app.post('/api/directives/:id/submit-update', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }

    const { 
      outcomes, 
      implementationStartDate,
      implementationEndDate,
      completionNote,
      updatedBy
    } = req.body;
    
    // Track what changed
    const changes = {};
    
    if (outcomes) {
      changes.outcomes = 'Updated outcome statuses';
      directive.outcomes = outcomes;
    }
    
    if (implementationStartDate) {
      changes.implementationStartDate = implementationStartDate;
      directive.implementationStartDate = new Date(implementationStartDate);
    }
    
    if (implementationEndDate) {
      changes.implementationEndDate = implementationEndDate;
      directive.implementationEndDate = new Date(implementationEndDate);
    }
    
    if (completionNote) {
      changes.completionNote = completionNote;
      directive.completionNote = completionNote;
    }
    
    // Record this submission in update history
    directive.updateHistory = directive.updateHistory || [];
    directive.updateHistory.push({
      updatedAt: new Date(),
      updatedBy: updatedBy || directive.owner,
      changes: changes,
      comment: completionNote || 'Status update submitted via portal'
    });
    
    // Mark as updated by SBU
    directive.lastSbuUpdate = new Date();
    directive.lastResponseDate = new Date();
    
    await directive.updateMonitoringStatus('SBU update received via submission portal');
    
    res.json({ 
      success: true, 
      data: directive,
      message: 'Update submitted successfully' 
    });
    
  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

