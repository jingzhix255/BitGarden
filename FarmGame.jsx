import React from 'react';

const FarmGame = () => {
  return (
    <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
      <iframe
        title="Godot Farm Game"
        // This points exactly to the folder we just put in 'public'
        src="/farm_build/index.html" 
        width="800"
        height="600"
        style={{
          border: '4px solid #4a3728', // A nice brown pixel-art style border
          borderRadius: '8px',
          backgroundColor: '#000000'
        }}
      />
    </div>
  );
};

export default FarmGame;